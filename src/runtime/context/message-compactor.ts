import { createHash } from 'node:crypto';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type {
  AgentContextCompaction,
  AgentContextInputManifest,
  AgentTask,
  AgentTaskRun,
} from '../../domain/index.js';
import type { ContextConfig } from '../../config/runtime-config.js';
import type { AgentStore } from '../../storage/agent-store.js';
import type { AuditedModelFactory } from '../model/audited-model.factory.js';
import { mapStoreError, RuntimeError } from '../errors/runtime-error.js';
import { projectModelInput } from '../model/model-input-accounting.js';
import { estimateTextTokens } from './helpers/token-budget.helper.js';
import {
  MODEL_INPUT_CONTEXT_RULES_VERSION,
  type ModelMessageGroup,
} from './types/model-input.types.js';

interface MessageCompactorOptions {
  store: AgentStore;
  modelFactory: AuditedModelFactory;
  config: ContextConfig;
  systemPromptVersion: string;
  inputTokenLimit: number;
  clock?: { nowMs(): number };
}

/** Performs one incremental summary update; original messages remain immutable. */
export class MessageCompactor {
  readonly #clock: { nowMs(): number };

  constructor(private readonly options: MessageCompactorOptions) {
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async compact(input: {
    task: AgentTask;
    taskRun: AgentTaskRun;
    groups: ModelMessageGroup[];
    current?: AgentContextCompaction;
    signal?: AbortSignal;
  }): Promise<AgentContextCompaction | undefined> {
    const eligible = selectOldConversationGroups(
      input.groups,
      input.task.goalMessageId,
      input.current?.throughMessageRowId ?? 0,
      this.options.config.keepRecentInputTokens
    );
    if (eligible.length === 0) return undefined;

    const prompt = [
      'Update the durable conversation summary using the previous summary and new transcript.',
      'Preserve user goals, decisions, verified outcomes, errors, artifact paths and unresolved work.',
      'Do not include temporary plan bookkeeping or invent facts.',
      `Return no more than ${this.options.config.summaryMaxTokens} estimated tokens.`,
    ].join('\n');
    const candidates = selectCompactionBatch({
      groups: eligible,
      prompt,
      previousSummary: input.current?.summary,
      inputTokenLimit: this.options.inputTokenLimit,
    });
    if (candidates.length === 0) {
      throw new RuntimeError(
        'model_input_too_large',
        'The oldest complete message group cannot fit in one context-compaction request.',
        {
          details: {
            groupId: eligible[0]!.id,
            estimatedGroupTokens: eligible[0]!.estimatedTokens,
            inputTokenLimit: this.options.inputTokenLimit,
          },
        }
      );
    }
    const throughMessageRowId = Math.max(...candidates.map(group => group.maxRowId));
    const transcript = candidates.map(formatGroup).join('\n\n');
    const messages = buildCompactionMessages(prompt, input.current?.summary, transcript);
    const manifest = compressionManifest(
      input.current,
      candidates,
      messages,
      prompt,
      this.options.config.summaryMaxTokens,
      this.options.systemPromptVersion
    );
    const model = this.options.modelFactory.create({
      task: input.task,
      taskRun: input.taskRun,
      manifest,
      callType: 'context.compress',
      logicalCallKey: `context.compress:${throughMessageRowId}`,
    });
    const response = await model.invoke(messages, { signal: input.signal });
    const summary = trimToEstimatedTokens(
      response.text.trim(),
      this.options.config.summaryMaxTokens
    );
    if (!summary) throw new Error('Context compaction model returned an empty summary.');
    if (!input.taskRun.ownerId) {
      throw new RuntimeError('ownership_lost', 'Context compaction requires an owned TaskRun.');
    }
    try {
      return await this.options.store.context.replaceCompaction({
        sessionId: input.task.sessionId,
        taskId: input.task.id,
        taskRunId: input.taskRun.id,
        ownerId: input.taskRun.ownerId,
        expectedVersion: input.current?.version ?? null,
        throughMessageRowId,
        summary,
        nowMs: this.#clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }
}

function selectCompactionBatch(input: {
  groups: ModelMessageGroup[];
  prompt: string;
  previousSummary?: string;
  inputTokenLimit: number;
}): ModelMessageGroup[] {
  let transcript = '';
  const selected: ModelMessageGroup[] = [];
  for (const group of input.groups) {
    const formatted = formatGroup(group);
    const nextTranscript = transcript ? `${transcript}\n\n${formatted}` : formatted;
    const messages = buildCompactionMessages(
      input.prompt,
      input.previousSummary,
      nextTranscript
    );
    if (projectModelInput(messages).estimatedTokens > input.inputTokenLimit) break;
    transcript = nextTranscript;
    selected.push(group);
  }
  return selected;
}

function buildCompactionMessages(
  prompt: string,
  previousSummary: string | undefined,
  transcript: string
) {
  return [
    new SystemMessage(prompt),
    new HumanMessage([
      previousSummary
        ? `Previous summary:\n${previousSummary}`
        : 'Previous summary: (none)',
      `New transcript:\n${transcript}`,
    ].join('\n\n')),
  ];
}

function selectOldConversationGroups(
  groups: ModelMessageGroup[],
  goalMessageId: string,
  currentCutoff: number,
  keepRecentInputTokens: number
): ModelMessageGroup[] {
  const conversation = groups.filter(group => (
    group.contextScope === 'conversation'
    && group.maxRowId > currentCutoff
    && !group.messages.some(message => message.id === goalMessageId)
  ));
  let keptTokens = 0;
  let firstKeptIndex = conversation.length;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const next = conversation[index]!;
    if (keptTokens + next.estimatedTokens > keepRecentInputTokens && keptTokens > 0) break;
    keptTokens += next.estimatedTokens;
    firstKeptIndex = index;
  }
  return conversation.slice(0, firstKeptIndex);
}

function formatGroup(group: ModelMessageGroup): string {
  return group.messages.map(message => JSON.stringify({
    id: message.id,
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    modelToolCallId: message.modelToolCallId,
    toolName: message.toolName,
    toolResult: message.toolResult,
  })).join('\n');
}

function compressionManifest(
  current: AgentContextCompaction | undefined,
  groups: ModelMessageGroup[],
  messages: ReturnType<typeof buildCompactionMessages>,
  prompt: string,
  reservedOutputTokens: number,
  systemPromptVersion: string
): AgentContextInputManifest {
  const totalTokens = projectModelInput(messages).estimatedTokens;
  const systemTokens = estimateTextTokens(prompt);
  const summaryTokens = current ? estimateTextTokens(current.summary) : 0;
  return {
    purpose: 'context.compress',
    contextRulesVersion: MODEL_INPUT_CONTEXT_RULES_VERSION,
    systemPromptVersion,
    messageGroupIds: groups.map(group => group.id),
    summaryIds: current ? [`context_compaction:${current.version}`] : [],
    fixedPrefixChecksum: createHash('sha256').update(prompt).digest('hex'),
    estimatedBreakdown: {
      system: systemTokens,
      tools: 0,
      summaries: summaryTokens,
      messages: Math.max(0, totalTokens - systemTokens - summaryTokens),
      reservedOutput: reservedOutputTokens,
    },
  };
}

function trimToEstimatedTokens(text: string, maxTokens: number): string {
  if (estimateTextTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).trimEnd();
}
