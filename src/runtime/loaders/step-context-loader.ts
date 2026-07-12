import { SystemMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentJob, AgentPlanStep, AgentStepRun } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import {
  CONTEXT_RULES_VERSION,
  LEGACY_CONTEXT_RULES_VERSION,
} from '../context/context-compiler.js';
import type { ContextMaterial, ContextModelBudget } from '../context/context-material.js';
import { messagesInGroup } from '../context/message-group-builder.js';
import { PlanContextLoader, type PlanContextStore } from './plan-context-loader.js';

export type StepContextStore = PlanContextStore & Pick<AgentStore,
  'listActiveContextSummaries'
>;

export interface StepContextLoaderOptions {
  store: StepContextStore;
  systemPrompt: string;
  systemPromptVersion: string;
  model: ContextModelBudget;
  toolSchemas: StructuredToolInterface[];
  compressionMessageThreshold: number;
  stableContext?: () => string | undefined;
}

export class StepContextLoader {
  readonly #plan: PlanContextLoader;

  constructor(private readonly options: StepContextLoaderOptions) {
    this.#plan = new PlanContextLoader(options.store);
  }

  async load(input: {
    job: AgentJob;
    originalGoal: string;
    step: AgentPlanStep;
    stepRun: AgentStepRun;
    contextRulesVersion?: string;
  }): Promise<ContextMaterial> {
    const contextRulesVersion = input.contextRulesVersion ?? CONTEXT_RULES_VERSION;
    const [context, summaries] = await Promise.all([
      this.#plan.load(input.job, input.originalGoal),
      this.options.store.listActiveContextSummaries(
        'step_run', input.stepRun.id, 'step_execution', contextRulesVersion
      ),
    ]);
    if (context.plan.id !== input.stepRun.planId || input.step.id !== input.stepRun.stepId) {
      throw new Error(`StepRun ${input.stepRun.id} does not match its PlanStep.`);
    }
    const stableContext = this.options.stableContext?.();
    const legacy = contextRulesVersion === LEGACY_CONTEXT_RULES_VERSION;
    const fixedPlanText = JSON.stringify({
      id: context.plan.id,
      title: context.plan.title,
      goal: context.plan.goal,
      steps: context.steps.map(step => ({
        id: step.id,
        position: step.position,
        title: step.title,
        instruction: step.instruction,
        ...(legacy ? { status: step.status } : {}),
      })),
      currentStepId: input.step.id,
      ...(legacy ? {
        currentStepRunId: input.stepRun.id,
        currentRunNo: input.stepRun.runNo,
      } : {}),
    });
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
    fixedMessages.push({
      id: 'must_keep:plan',
      message: new SystemMessage(`Current execution plan:\n${fixedPlanText}`),
      text: fixedPlanText,
    });
    const currentInstruction =
      `Current PlanStep — execute only this step. Do not execute later PlanSteps:\n${input.step.instruction}`;
    const allSummaries = [...(legacy ? [] : context.facts.summaries), ...summaries]
      .filter((summary, index, values) => values.findIndex(value => value.id === summary.id) === index);
    const summaryEnd = Math.max(0, ...allSummaries.map(summary => summary.sourceRowIdEnd));
    const selectedSessionGroups = legacy ? context.legacySessionBaseline : context.sessionBaseline;
    const selectedPlanGroups = legacy ? context.legacyCurrentPlanGroups : context.currentPlanGroups;
    const sessionGroups = selectedSessionGroups.map(group => ({
      group,
      segment: 'session_history' as const,
      mustKeep: messagesInGroup(group).some(message => (
        message.id === context.originalGoalMessage.id
      )),
      priority: messagesInGroup(group).some(message => (
        message.id === context.originalGoalMessage.id
      )) ? 1_000 : group.type === 'step_output' ? 80 : 40,
    }));
    const planGroups = selectedPlanGroups.map(group => ({
      group,
      segment: messagesInGroup(group).some(message => (
        message.stepRunId === input.stepRun.id
      )) ? 'current_step' as const : 'current_plan' as const,
      mustKeep: true,
      priority: 1_000,
    }));
    const compressionCandidateMessageIds = context.currentPlanGroups.flatMap(group => {
      const messages = messagesInGroup(group);
      return group.type === 'step_output' || messages.some(message => (
        message.stepRunId === input.stepRun.id
      )) ? messages.map(message => message.id) : [];
    });
    return {
      fixedMessages,
      trailingMessages: [{
        id: 'must_keep:instruction',
        message: new SystemMessage(currentInstruction),
        text: currentInstruction,
      }],
      fixedPrefix: {
        systemPrompt: this.options.systemPrompt,
        stableContext,
        originalGoal: input.originalGoal,
        currentInstruction,
        plan: fixedPlanText,
      },
      groups: [...sessionGroups, ...planGroups],
      legacyGroups: [
        ...context.legacySessionBaseline.map(group => ({
          group, segment: 'session_history' as const,
          mustKeep: messagesInGroup(group).some(message => message.id === context.originalGoalMessage.id),
          priority: 40,
        })),
        ...context.legacyCurrentPlanGroups.map(group => ({
          group, segment: 'current_plan' as const, mustKeep: true, priority: 1_000,
        })),
      ],
      ...(legacy ? {} : { bundles: context.facts.bundles.map(bundle => {
        const current = bundle.jobIds.includes(input.job.id);
        const projected = current
          ? {
              ...bundle,
              groups: bundle.groups.filter(group => !(
                group.type === 'plan_definition' && group.plan.id === context.plan.id
              )),
            }
          : bundle;
        return {
          bundle: projected,
          segment: current ? 'current_plan' as const : 'session_history' as const,
          mustKeep: current,
          priority: current ? 1_000 : 40,
        };
      }) }),
      summaries: allSummaries.map(summary => ({
        id: summary.id,
        summary: summary.summary,
        sourceRowIdEnd: summary.sourceRowIdEnd,
        sourceBundleIds: readStringArray(summary.metadata?.sourceBundleIds),
      })),
      toolSchemas: this.options.toolSchemas,
      model: this.options.model,
      audit: {
        purpose: 'step_execution',
        contextRulesVersion,
        systemPromptVersion: this.options.systemPromptVersion,
      },
      blockedDiagnostics: context.facts.blocked.map(item => ({
        messageId: item.callMessage.id,
        reason: item.reason,
        ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
      })),
      compression: {
        disabled: false,
        newCompressibleMessageCount: context.facts.messages.filter(message => (
          message.rowId > summaryEnd
          && message.id !== context.originalGoalMessage.id
        )).length,
        messageThreshold: this.options.compressionMessageThreshold,
        candidateMessageIds: compressionCandidateMessageIds,
      },
    };
  }
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined;
}
