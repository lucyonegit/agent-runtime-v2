import { SystemMessage } from '@langchain/core/messages';
import type {
  AgentArtifact,
  AgentContextSummary,
  AgentJob,
  AgentPlan,
  AgentPlanStep,
  AgentUserInputRequest,
} from '../../../domain/index.js';
import { jobGoalMessageId } from '../../../domain/index.js';
import {
  buildDurableRuntimeStatePrompt,
  createJobPromptManifest,
} from '../../prompting/job-agent-prompt.js';
import { CONTEXT_RULES_VERSION } from '../context-compiler.js';
import type {
  ContextMaterial,
  ReActContextMaterialOptions,
  TurnBundle,
} from '../types/context.types.js';
import type {
  BlockedMessageGroup,
  MessageGroup,
} from '../types/message-group.types.js';
import {
  assertNoBlockedMessageGroups,
  MessageGroupBuilder,
  messagesInGroup,
} from './message-group.helper.js';
import { calibrateModelBudget } from './model-budget.helper.js';
import { TurnBundleBuilder } from './turn-bundle.helper.js';

export async function loadJobContextMaterial(
  options: ReActContextMaterialOptions,
  job: AgentJob,
  originalGoal: string,
  contextRulesVersion = CONTEXT_RULES_VERSION
): Promise<ContextMaterial> {
  const [facts, modelCalls] = await Promise.all([
    loadSessionFacts(options, job.sessionId),
    options.store.listRecentSessionModelCalls(job.sessionId, 100),
  ]);
  assertNoBlockedMessageGroups(
    facts.blocked,
    blocked => blocked.callMessage.jobId === job.id
  );
  return buildContextMaterial(options, {
    sessionId: job.sessionId,
    facts,
    modelCalls,
    job,
    originalGoal,
    contextRulesVersion,
  });
}

export async function loadNextTurnContextMaterial(
  options: ReActContextMaterialOptions,
  sessionId: string
): Promise<{ material: ContextMaterial; latestJobId?: string }> {
  const [facts, modelCalls] = await Promise.all([
    loadSessionFacts(options, sessionId),
    options.store.listRecentSessionModelCalls(sessionId, 100),
  ]);
  return {
    material: buildContextMaterial(options, {
      sessionId,
      facts,
      modelCalls,
      contextRulesVersion: CONTEXT_RULES_VERSION,
    }),
    latestJobId: latestJobId(facts.jobs),
  };
}

interface SessionFacts {
  jobs: AgentJob[];
  summaries: AgentContextSummary[];
  plans: AgentPlan[];
  planSteps: AgentPlanStep[];
  artifacts: AgentArtifact[];
  userInputRequests: AgentUserInputRequest[];
  groups: MessageGroup[];
  bundles: TurnBundle[];
  blocked: BlockedMessageGroup[];
}

async function loadSessionFacts(
  options: ReActContextMaterialOptions,
  sessionId: string
): Promise<SessionFacts> {
  const [
    jobs, messages, invocations, summaries, plans, planSteps, artifacts, userInputRequests,
  ] = await Promise.all([
    options.store.listSessionJobs(sessionId),
    options.store.listSessionMessages(sessionId),
    options.store.listSessionToolInvocations(sessionId),
    options.store.listActiveContextSummaries(
      'session',
      sessionId,
      'conversation',
      CONTEXT_RULES_VERSION
    ),
    options.store.listSessionPlans?.(sessionId) ?? Promise.resolve([]),
    options.store.listSessionPlanSteps?.(sessionId) ?? Promise.resolve([]),
    options.store.listSessionArtifacts?.(sessionId) ?? Promise.resolve([]),
    options.store.listSessionUserInputRequests?.(sessionId) ?? Promise.resolve([]),
  ]);
  const built = new MessageGroupBuilder().build(messages, invocations);
  const groups = built.groups.filter(isModelVisibleGroup);
  return {
    jobs,
    summaries,
    plans,
    planSteps,
    artifacts,
    userInputRequests,
    groups,
    bundles: new TurnBundleBuilder().build({ sessionId, jobs, groups }),
    blocked: built.blocked,
  };
}

function buildContextMaterial(
  options: ReActContextMaterialOptions,
  input: {
    sessionId: string;
    facts: SessionFacts;
    modelCalls: Awaited<ReturnType<
      ReActContextMaterialOptions['store']['listRecentSessionModelCalls']
    >>;
    job?: AgentJob;
    originalGoal?: string;
    contextRulesVersion: string;
  }
): ContextMaterial {
  const { facts, job } = input;
  const stableContext = options.getStableContext?.(input.sessionId);
  const fixedMessages: ContextMaterial['fixedMessages'] = [{
    id: 'must_keep:system',
    message: new SystemMessage(options.systemPrompt),
    text: options.systemPrompt,
  }];
  if (stableContext) {
    fixedMessages.push({
      id: 'must_keep:stable',
      message: new SystemMessage(stableContext),
      text: stableContext,
    });
  }

  const goalId = job ? jobGoalMessageId(job) : undefined;
  const trailingMessages = buildRuntimeStateMessages(facts, job);
  const groups = facts.groups.map(group => {
    const messages = messagesInGroup(group);
    const currentGoal = job
      ? goalId
        ? messages.some(message => message.id === goalId)
        : messages.some(message => (
            message.jobId === job.id
            && message.messageType === 'user_message'
            && message.content === input.originalGoal
          ))
      : false;
    const currentExecution = job
      ? messages.some(message => message.jobId === job.id)
      : false;
    return {
      group,
      segment: currentExecution ? 'current_job' as const : 'session_history' as const,
      mustKeep: currentGoal,
      priority: currentGoal ? 1_000 : currentExecution ? 70 : 40,
    };
  });
  const bundles = facts.bundles.map(bundle => {
    const current = job
      ? bundle.jobIds.includes(job.id)
        || Boolean(job.retryOfJobId && bundle.jobIds.includes(job.retryOfJobId))
      : false;
    return {
      bundle,
      segment: current ? 'current_job' as const : 'session_history' as const,
      mustKeep: current,
      priority: current ? 1_000 : 40,
    };
  });

  return {
    fixedMessages,
    trailingMessages,
    fixedPrefix: { systemPrompt: options.systemPrompt, stableContext },
    groups,
    bundles,
    summaries: facts.summaries.map(toSummaryMaterial),
    toolSchemas: options.toolSchemas,
    model: calibrateModelBudget(options.model, input.modelCalls),
    audit: {
      purpose: 'job_execution',
      contextRulesVersion: input.contextRulesVersion,
      systemPromptVersion: options.systemPromptVersion,
      ...(options.promptId && options.promptVersion !== undefined ? {
        prompt: createJobPromptManifest({
          systemPrompt: options.systemPrompt,
          promptId: options.promptId,
          promptVersion: options.promptVersion,
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
      recentRawTokenBudget: options.recentRawTokenBudget ?? 24_000,
      minimumRecentGroups: options.minimumRecentGroups ?? 2,
      ...(goalId ? { protectedMessageIds: [goalId] } : {}),
    },
  };
}

function buildRuntimeStateMessages(facts: SessionFacts, job?: AgentJob) {
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

function isModelVisibleGroup(group: MessageGroup): boolean {
  return !messagesInGroup(group).some(message => (
    message.visibility === 'internal' || message.messageType === 'progress'
  ));
}

function latestArtifactRevisions(artifacts: AgentArtifact[]): AgentArtifact[] {
  const byPath = new Map<string, AgentArtifact>();
  for (const artifact of artifacts) {
    const current = byPath.get(artifact.logicalPath);
    if (!current || artifact.revision > current.revision) {
      byPath.set(artifact.logicalPath, artifact);
    }
  }
  return [...byPath.values()].sort((left, right) => (
    left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id)
  ));
}

function toSummaryMaterial(summary: AgentContextSummary): ContextMaterial['summaries'][number] {
  return {
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
  };
}

function latestJobId(jobs: AgentJob[]): string | undefined {
  return [...jobs].sort((left, right) => (
    right.createdAtMs - left.createdAtMs || right.id.localeCompare(left.id)
  ))[0]?.id;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined;
}
