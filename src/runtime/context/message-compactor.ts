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
import { estimateTextTokens } from './helpers/token-budget.helper.js';
import type { ModelMessageGroup } from './types/model-input.types.js';

interface MessageCompactorOptions {
  store: AgentStore;
  modelFactory: AuditedModelFactory;
  config: ContextConfig;
  systemPromptVersion: string;
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
    const candidates = selectOldConversationGroups(
      input.groups,
      input.task.goalMessageId,
      input.current?.throughMessageRowId ?? 0,
      this.options.config.keepRecentInputTokens
    );
    if (candidates.length === 0) return undefined;

    const throughMessageRowId = Math.max(...candidates.map(group => group.maxRowId));
    const transcript = candidates.map(formatGroup).join('\n\n');
    const prompt = [
      'Update the durable conversation summary using the previous summary and new transcript.',
      'Preserve user goals, decisions, verified outcomes, errors, artifact paths and unresolved work.',
      'Do not include temporary plan bookkeeping or invent facts.',
      `Return no more than ${this.options.config.summaryMaxTokens} estimated tokens.`,
    ].join('\n');
    const messages = [
      new SystemMessage(prompt),
      new HumanMessage([
        input.current?.summary
          ? `Previous summary:\n${input.current.summary}`
          : 'Previous summary: (none)',
        `New transcript:\n${transcript}`,
      ].join('\n\n')),
    ];
    const manifest = compressionManifest(
      input.current,
      candidates,
      messages.map(message => message.text).join('\n'),
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
    return this.options.store.context.replaceCompaction({
      sessionId: input.task.sessionId,
      throughMessageRowId,
      summary,
      nowMs: this.#clock.nowMs(),
    });
  }
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
  text: string,
  systemPromptVersion: string
): AgentContextInputManifest {
  const tokens = estimateTextTokens(text);
  return {
    purpose: 'context.compress',
    contextRulesVersion: 'model-input-v1',
    systemPromptVersion,
    messageGroupIds: groups.map(group => group.id),
    summaryIds: current ? [`context_compaction:${current.version}`] : [],
    fixedPrefixChecksum: 'context-compress-v1',
    estimatedBreakdown: {
      system: estimateTextTokens('context compaction'),
      tools: 0,
      summaries: current ? estimateTextTokens(current.summary) : 0,
      messages: tokens,
      reservedOutput: 0,
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
