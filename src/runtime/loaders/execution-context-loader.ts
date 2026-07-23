import { SystemMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentJob, AgentModelCall } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { jobGoalMessageId } from '../job-goal.js';
import { CONTEXT_RULES_VERSION } from '../context/context-compiler.js';
import type { ContextMaterial, ContextModelBudget } from '../context/context-material.js';
import { messagesInGroup } from '../context/message-group-builder.js';
import {
  buildDurableRuntimeStatePrompt,
  createJobPromptManifest,
} from '../prompting/job-agent-prompt.js';
import {
  SessionContextLoader,
  assertNoBlockedGroups,
  type SessionContextStore,
} from './session-context-loader.js';

type ExecutionContextStore = SessionContextStore
  & Pick<AgentStore, 'listRecentSessionModelCalls'>;

export interface ExecutionContextLoaderOptions {
  store: ExecutionContextStore;
  systemPrompt: string;
  systemPromptVersion: string;
  model: ContextModelBudget;
  toolSchemas: StructuredToolInterface[];
  promptId?: string;
  promptVersion?: number;
  stableContext?: (sessionId: string) => string | undefined;
  recentRawTokenBudget?: number;
  minimumRecentGroups?: number;
}

/** Loads durable facts for the next iteration of the single ReAct loop. */
export class ExecutionContextLoader {
  readonly #session: SessionContextLoader;

  constructor(private readonly options: ExecutionContextLoaderOptions) {
    this.#session = new SessionContextLoader(options.store);
  }

  async load(
    job: AgentJob,
    originalGoal: string,
    contextRulesVersion = CONTEXT_RULES_VERSION
  ): Promise<ContextMaterial> {
    const [facts, modelCalls] = await Promise.all([
      this.#session.load(job.sessionId),
      this.options.store.listRecentSessionModelCalls(job.sessionId, 100),
    ]);
    assertNoBlockedGroups(facts.blocked, blocked => blocked.callMessage.jobId === job.id);
    const goalId = jobGoalMessageId(job);
    const stableContext = this.options.stableContext?.(job.sessionId);
    const trailingMessages = buildDurableRuntimeStateMessages(facts, job);
    const fixedMessages = [{
      id: 'must_keep:system',
      message: new SystemMessage(this.options.systemPrompt),
      text: this.options.systemPrompt,
    }];
    if (stableContext) {
      fixedMessages.push({
        id: 'must_keep:stable',
        message: new SystemMessage(stableContext),
        text: stableContext,
      });
    }
    const groupMaterial = facts.groups.map(group => {
      const messages = messagesInGroup(group);
      const currentGoal = goalId
        ? messages.some(message => message.id === goalId)
        : messages.some(message => (
            message.jobId === job.id
            && message.messageType === 'user_message'
            && message.content === originalGoal
          ));
      const currentExecution = messages.some(message => message.jobId === job.id);
      return {
        group,
        segment: currentExecution ? 'current_job' as const : 'session_history' as const,
        mustKeep: currentGoal,
        priority: currentGoal ? 1_000 : currentExecution ? 70 : 40,
      };
    });
    return {
      fixedMessages,
      trailingMessages,
      // Only truly stable data belongs in the reusable provider prefix.
      fixedPrefix: { systemPrompt: this.options.systemPrompt, stableContext },
      groups: groupMaterial,
      bundles: facts.bundles.map(bundle => {
        const current = bundle.jobIds.includes(job.id)
          || (job.retryOfJobId ? bundle.jobIds.includes(job.retryOfJobId) : false);
        return {
          bundle,
          segment: current ? 'current_job' as const : 'session_history' as const,
          // Selection protects the live turn. Compression itself deliberately
          // works below this level and may summarize its older stable groups.
          mustKeep: current,
          priority: current ? 1_000 : 40,
        };
      }),
      summaries: facts.summaries.map(summary => ({
        id: summary.id,
        summaryType: summary.summaryType,
        compressionPromptVersion: summary.compressionPromptVersion,
        summary: summary.summary,
        sourceRowIdStart: summary.sourceRowIdStart,
        sourceRowIdEnd: summary.sourceRowIdEnd,
        sourceGroupIds: readStringArray(summary.metadata?.sourceGroupIds),
        sourceBundleIds: readStringArray(summary.metadata?.sourceBundleIds),
        sourceMessageCount: summary.sourceMessageCount,
        sourceTokenCount: summary.sourceTokenCount,
      })),
      toolSchemas: this.options.toolSchemas,
      model: calibrateModelBudget(this.options.model, modelCalls),
      audit: {
        purpose: 'job_execution',
        contextRulesVersion,
        systemPromptVersion: this.options.systemPromptVersion,
        ...(this.options.promptId && this.options.promptVersion !== undefined ? {
          prompt: createJobPromptManifest({
            systemPrompt: this.options.systemPrompt,
            promptId: this.options.promptId,
            promptVersion: this.options.promptVersion,
            stableContext,
            runtimeStateMessages: trailingMessages.map(message => message.text),
          }),
        } : {}),
      },
      blockedDiagnostics: facts.blocked.map(item => ({
        messageId: item.callMessage.id,
        reason: item.reason,
        ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
      })),
      compression: {
        disabled: false,
        recentRawTokenBudget: this.options.recentRawTokenBudget ?? 24_000,
        minimumRecentGroups: this.options.minimumRecentGroups ?? 2,
        protectedMessageIds: goalId ? [goalId] : [],
      },
    };
  }
}

export function buildDurableRuntimeStateMessages(
  facts: Awaited<ReturnType<SessionContextLoader['load']>>,
  job?: AgentJob
) {
  const plan = [...facts.plans]
    .filter(item => job ? item.jobId === job.id : item.status === 'active')
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  const planSteps = plan
    ? facts.planSteps
      .filter(step => step.planId === plan.id)
      .sort((left, right) => left.position - right.position)
      .map(step => ({
        id: step.id,
        key: step.key,
        position: step.position,
        title: step.title,
        status: step.status,
        result: step.result,
        error: step.error,
      }))
    : [];
  const latestArtifacts = latestArtifactRevisions(facts.artifacts).slice(-100).map(artifact => ({
    id: artifact.id,
    jobId: artifact.jobId,
    logicalPath: artifact.logicalPath,
    title: artifact.title,
    mediaType: artifact.mediaType,
    size: artifact.size,
    checksum: artifact.checksum,
    revision: artifact.revision,
  }));
  const pendingInputRequests = facts.userInputRequests
    .filter(request => (!job || request.jobId === job.id) && request.status === 'pending')
    .map(request => ({
      id: request.id,
      source: request.source,
      answerMode: request.answerMode,
      title: request.title,
      prompt: request.prompt,
    }));
  if (!plan && latestArtifacts.length === 0 && pendingInputRequests.length === 0) return [];
  const state = {
    job: job ? { id: job.id, status: job.status, attemptNo: job.attemptNo } : undefined,
    plan: plan ? {
      id: plan.id,
      title: plan.title,
      goal: plan.goal,
      status: plan.status,
      version: plan.version,
      steps: planSteps,
    } : undefined,
    artifacts: latestArtifacts,
    pendingUserInputRequests: pendingInputRequests,
  };
  const text = buildDurableRuntimeStatePrompt(state);
  return [{ id: 'must_keep:runtime_state', message: new SystemMessage(text), text }];
}

function latestArtifactRevisions(
  artifacts: Awaited<ReturnType<NonNullable<SessionContextStore['listSessionArtifacts']>>>
) {
  const byPath = new Map<string, (typeof artifacts)[number]>();
  for (const artifact of artifacts) {
    const current = byPath.get(artifact.logicalPath);
    if (!current || artifact.revision > current.revision) byPath.set(artifact.logicalPath, artifact);
  }
  return [...byPath.values()].sort((left, right) => (
    left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id)
  ));
}

export function calibrateModelBudget(
  model: ContextModelBudget,
  calls: AgentModelCall[]
): ContextModelBudget {
  const samples = calls.filter(call => (
    call.status === 'completed'
    && call.callType === 'job.react'
    && call.provider === model.provider
    && call.model === model.name
    && typeof call.actualInputTokens === 'number'
    && call.actualInputTokens > 0
    && rawEstimatedInputTokens(call) > 0
  )).slice(-100);
  if (samples.length < 10) {
    return {
      ...model,
      tokenCalibrationFactor: model.tokenCalibrationFactor ?? 1.1,
      tokenErrorReserve: model.tokenErrorReserve ?? 256,
      tokenCalibrationSampleCount: samples.length,
    };
  }
  const ratios = samples
    .map(call => call.actualInputTokens! / rawEstimatedInputTokens(call))
    .sort((left, right) => left - right);
  const p95 = percentile(ratios, 0.95);
  // Never shrink a safety estimate merely because the latest sample happened
  // to tokenize cheaply; cap pathological provider data as well.
  const factor = Math.min(1.75, Math.max(1, p95));
  const residuals = samples
    .map(call => Math.max(0, call.actualInputTokens! - rawEstimatedInputTokens(call) * factor))
    .sort((left, right) => left - right);
  return {
    ...model,
    tokenCalibrationFactor: factor,
    tokenErrorReserve: Math.max(64, Math.ceil(percentile(residuals, 0.95))),
    tokenCalibrationSampleCount: samples.length,
  };
}

function rawEstimatedInputTokens(call: AgentModelCall): number {
  return call.inputManifest.tokenPrediction?.rawEstimatedInputTokens
    ?? call.estimatedInputTokens;
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index]!;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined;
}
