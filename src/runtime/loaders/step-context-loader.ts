import { SystemMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentJob, AgentPlanStep, AgentStepRun } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import {
  CONTEXT_RULES_VERSION,
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
  }): Promise<ContextMaterial> {
    const [context, summaries] = await Promise.all([
      this.#plan.load(input.job, input.originalGoal),
      this.options.store.listActiveContextSummaries(
        'step_run', input.stepRun.id, 'step_execution', CONTEXT_RULES_VERSION
      ),
    ]);
    if (context.plan.id !== input.stepRun.planId || input.step.id !== input.stepRun.stepId) {
      throw new Error(`StepRun ${input.stepRun.id} does not match its PlanStep.`);
    }
    const stableContext = this.options.stableContext?.();
    const planText = JSON.stringify({
      id: context.plan.id,
      title: context.plan.title,
      goal: context.plan.goal,
      steps: context.steps.map(step => ({
        id: step.id,
        position: step.position,
        title: step.title,
        instruction: step.instruction,
        status: step.status,
      })),
      currentStepId: input.step.id,
      currentStepRunId: input.stepRun.id,
      currentRunNo: input.stepRun.runNo,
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
      message: new SystemMessage(`Current execution plan:\n${planText}`),
      text: planText,
    });
    const currentInstruction =
      `Current PlanStep — execute only this step. Do not execute later PlanSteps:\n${input.step.instruction}`;
    const summaryEnd = Math.max(0, ...summaries.map(summary => summary.sourceRowIdEnd));
    const sessionGroups = context.sessionBaseline.map(group => ({
      group,
      segment: 'session_history' as const,
      mustKeep: messagesInGroup(group).some(message => (
        message.id === context.originalGoalMessage.id
      )),
      priority: messagesInGroup(group).some(message => (
        message.id === context.originalGoalMessage.id
      )) ? 1_000 : group.type === 'step_output' ? 80 : 40,
    }));
    const planGroups = context.currentPlanGroups.map(group => ({
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
        plan: planText,
      },
      groups: [...sessionGroups, ...planGroups],
      summaries: summaries.map(summary => ({
        id: summary.id,
        summary: summary.summary,
        sourceRowIdEnd: summary.sourceRowIdEnd,
      })),
      toolSchemas: this.options.toolSchemas,
      model: this.options.model,
      audit: {
        purpose: 'step_execution',
        contextRulesVersion: CONTEXT_RULES_VERSION,
        systemPromptVersion: this.options.systemPromptVersion,
      },
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
