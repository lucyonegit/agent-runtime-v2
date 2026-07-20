import { SystemMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentJob } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { jobGoalMessageId } from '../job-goal.js';
import { CONTEXT_RULES_VERSION } from '../context/context-compiler.js';
import type { ContextMaterial, ContextModelBudget } from '../context/context-material.js';
import { messagesInGroup } from '../context/message-group-builder.js';
import {
  SessionContextLoader,
  assertNoBlockedGroups,
} from './session-context-loader.js';

export type JobContextStore = Pick<AgentStore,
  | 'listSessionJobs'
  | 'listSessionMessages'
  | 'listSessionToolInvocations'
  | 'listActiveContextSummaries'
>;

export interface JobContextLoaderOptions {
  store: JobContextStore;
  systemPrompt: string;
  systemPromptVersion: string;
  model: ContextModelBudget;
  toolSchemas: StructuredToolInterface[];
  compressionMessageThreshold: number;
  stableContext?: () => string | undefined;
}

export class JobContextLoader {
  readonly #session: SessionContextLoader;

  constructor(private readonly options: JobContextLoaderOptions) {
    this.#session = new SessionContextLoader(options.store);
  }

  async load(
    job: AgentJob,
    originalGoal: string,
    contextRulesVersion = CONTEXT_RULES_VERSION
  ): Promise<ContextMaterial> {
    const facts = await this.#session.load(job.sessionId);
    const summaries = facts.summaries;
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
    const groupMaterial = facts.groups.map(group => {
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
        priority: currentGoal ? 1_000 : currentJob ? 70 : 40,
      };
    });
    return {
      fixedMessages,
      fixedPrefix: {
        systemPrompt: this.options.systemPrompt,
        stableContext,
        originalGoal,
        currentInstruction: undefined,
      },
      groups: groupMaterial,
      bundles: facts.bundles.map(bundle => {
        const current = bundle.jobIds.includes(job.id)
          || (job.retryOfJobId ? bundle.jobIds.includes(job.retryOfJobId) : false);
        return {
          bundle,
          segment: current ? 'current_job' as const : 'session_history' as const,
          mustKeep: current,
          priority: current ? 1_000 : 40,
        };
      }),
      summaries: summaries.map(summary => ({
        id: summary.id,
        summary: summary.summary,
        sourceRowIdEnd: summary.sourceRowIdEnd,
        sourceBundleIds: readStringArray(summary.metadata?.sourceBundleIds),
      })),
      toolSchemas: this.options.toolSchemas,
      model: this.options.model,
      audit: {
        purpose: 'job_execution',
        contextRulesVersion,
        systemPromptVersion: this.options.systemPromptVersion,
      },
      blockedDiagnostics: facts.blocked.map(item => ({
        messageId: item.callMessage.id,
        reason: item.reason,
        ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
      })),
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

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined;
}
