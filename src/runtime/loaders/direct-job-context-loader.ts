import { SystemMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentJob } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { jobGoalMessageId } from '../job-goal.js';
import {
  CONTEXT_RULES_VERSION,
} from '../context/context-compiler.js';
import type { ContextMaterial, ContextModelBudget } from '../context/context-material.js';
import { messagesInGroup } from '../context/message-group-builder.js';
import {
  SessionContextLoader,
  assertNoBlockedGroups,
} from './session-context-loader.js';

export type DirectJobContextStore = Pick<AgentStore,
  | 'listSessionMessages'
  | 'listSessionToolInvocations'
  | 'listActiveContextSummaries'
>;

export interface DirectJobContextLoaderOptions {
  store: DirectJobContextStore;
  systemPrompt: string;
  systemPromptVersion: string;
  model: ContextModelBudget;
  toolSchemas: StructuredToolInterface[];
  compressionMessageThreshold: number;
  stableContext?: () => string | undefined;
}

export class DirectJobContextLoader {
  readonly #session: SessionContextLoader;

  constructor(private readonly options: DirectJobContextLoaderOptions) {
    this.#session = new SessionContextLoader(options.store);
  }

  async load(job: AgentJob, originalGoal: string): Promise<ContextMaterial> {
    const [facts, summaries] = await Promise.all([
      this.#session.load(job.sessionId),
      this.options.store.listActiveContextSummaries(
        'job', job.id, 'job_execution', CONTEXT_RULES_VERSION
      ),
    ]);
    assertNoBlockedGroups(facts.blocked, blocked => blocked.callMessage.jobId === job.id);
    const goalId = jobGoalMessageId(job);
    const stableContext = this.options.stableContext?.();
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
    const summaryEnd = Math.max(0, ...summaries.map(summary => summary.sourceRowIdEnd));
    return {
      fixedMessages,
      fixedPrefix: {
        systemPrompt: this.options.systemPrompt,
        stableContext,
        originalGoal,
        currentInstruction: undefined,
      },
      groups: facts.groups.map(group => {
        const messages = messagesInGroup(group);
        const currentGoal = goalId
          ? messages.some(message => message.id === goalId)
          : messages.some(message => (
              message.jobId === job.id
              && message.messageType === 'user_message'
              && message.content === originalGoal
            ));
        const currentJob = messages.some(message => message.jobId === job.id);
        return {
          group,
          segment: currentJob ? 'current_job' as const : 'session_history' as const,
          mustKeep: currentGoal,
          priority: currentGoal ? 1_000 : group.type === 'step_output' ? 80 : currentJob ? 70 : 40,
        };
      }),
      summaries: summaries.map(summary => ({
        id: summary.id,
        summary: summary.summary,
        sourceRowIdEnd: summary.sourceRowIdEnd,
      })),
      toolSchemas: this.options.toolSchemas,
      model: this.options.model,
      audit: {
        purpose: 'job_execution',
        contextRulesVersion: CONTEXT_RULES_VERSION,
        systemPromptVersion: this.options.systemPromptVersion,
      },
      compression: {
        disabled: false,
        newCompressibleMessageCount: facts.messages.filter(message => (
          message.rowId > summaryEnd && message.id !== goalId
        )).length,
        messageThreshold: this.options.compressionMessageThreshold,
      },
    };
  }
}
