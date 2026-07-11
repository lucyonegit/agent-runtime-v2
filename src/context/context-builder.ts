import { createHash } from 'node:crypto';
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type {
  AgentContextInputManifest,
  AgentJob,
  AgentStepRun,
  AgentToolInvocation,
  AgentMessage,
} from '../domain/index.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { ContextFilter } from './context-filter.js';
import { ContextFormatter } from './context-formatter.js';
import { CONTEXT_RULES_VERSION, type ContextPurpose } from './context-purpose.js';
import {
  MessageGroupBuilder,
  messagesInGroup,
  type MessageGroup,
} from './message-group-builder.js';
import { ContextSummaryManager } from './context-summary-manager.js';
import {
  TokenBudget,
  estimateTextTokens,
  type TokenBudgetItem,
} from './token-budget.js';

export interface BuildContextInput {
  job: AgentJob;
  stepRun?: AgentStepRun;
  attemptId: string;
  purpose: ContextPurpose;
  systemPrompt: string;
  systemPromptVersion: string;
  originalGoal: string;
  currentInstruction?: string;
  stableContext?: string;
  messages: AgentMessage[];
  invocations: AgentToolInvocation[];
  summaries?: Array<{ id: string; summary: string; sourceRowIdEnd?: number }>;
  model: {
    provider: string;
    name: string;
    maxContextTokens: number;
    reservedOutputTokens: number;
  };
  toolSchemas?: StructuredToolInterface[];
  newCompressibleMessageCount?: number;
  compressionMessageThreshold?: number;
  compressionSourcePurpose?: Exclude<ContextPurpose, 'context_compression'>;
}

export interface BuiltContext {
  messages: BaseMessage[];
  inputManifest: AgentContextInputManifest;
  estimatedInputTokens: number;
  contextRulesVersion: string;
  summaryIds: string[];
  compressionRecommended: boolean;
}

type ContextItem =
  | { kind: 'message'; message: BaseMessage; category: 'system' | 'messages' }
  | { kind: 'tools'; category: 'tools' }
  | { kind: 'summary'; id: string; message: BaseMessage; category: 'summaries' }
  | { kind: 'group'; group: MessageGroup; category: 'messages' };

export class IncompleteMessageGroupError extends Error {
  readonly code = 'incomplete_message_group';

  constructor(message: string) {
    super(message);
    this.name = 'IncompleteMessageGroupError';
  }
}

export class ContextBuilder {
  readonly #groupBuilder = new MessageGroupBuilder();
  readonly #filter = new ContextFilter();
  readonly #formatter = new ContextFormatter();
  readonly #budget = new TokenBudget();
  readonly #summaries = new ContextSummaryManager();

  build(input: BuildContextInput): BuiltContext {
    const builtGroups = this.#groupBuilder.build(input.messages, input.invocations);
    const relevantBlocked = builtGroups.blocked.find(blocked => (
      blocked.callMessage.jobId === input.job.id
      && (!input.stepRun || blocked.callMessage.stepRunId === input.stepRun.id)
    ));
    if (relevantBlocked) {
      throw new IncompleteMessageGroupError(
        `Tool exchange ${JSON.stringify(relevantBlocked.callMessage.id)} is incomplete: ${relevantBlocked.reason}.`
      );
    }
    const groups = this.#filter.filter(builtGroups.groups, {
      purpose: input.purpose === 'context_compression'
        ? input.compressionSourcePurpose ?? 'conversation'
        : input.purpose,
      currentJobId: input.job.id,
      currentStepRunId: input.stepRun?.id,
    });
    const items: Array<TokenBudgetItem<ContextItem>> = [];
    let order = 0;
    const addMandatoryMessage = (id: string, message: BaseMessage, text: string) => {
      items.push({
        id,
        value: { kind: 'message', message, category: 'system' },
        estimatedTokens: estimateTextTokens(text),
        mandatory: true,
        priority: 1_000,
        recency: 0,
        originalOrder: order++,
      });
    };
    addMandatoryMessage('mandatory:system', new SystemMessage(input.systemPrompt), input.systemPrompt);
    if (input.stableContext) {
      addMandatoryMessage(
        'mandatory:stable',
        new SystemMessage(input.stableContext),
        input.stableContext
      );
    }
    addMandatoryMessage('mandatory:goal', new HumanMessage(input.originalGoal), input.originalGoal);
    if (input.currentInstruction) {
      addMandatoryMessage(
        'mandatory:instruction',
        new SystemMessage(input.currentInstruction),
        input.currentInstruction
      );
    }
    const toolSchemas = input.toolSchemas ?? [];
    if (toolSchemas.length > 0) {
      const serializedTools = canonicalJson(toolSchemas.map(tool => ({
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
      })));
      items.push({
        id: 'mandatory:tools',
        value: { kind: 'tools', category: 'tools' },
        estimatedTokens: estimateTextTokens(serializedTools),
        mandatory: true,
        priority: 1_000,
        recency: 0,
        originalOrder: order++,
      });
    }
    const maxCoveredRowId = Math.max(0, ...(input.summaries ?? []).map(summary => summary.sourceRowIdEnd ?? 0));
    for (const summary of input.summaries ?? []) {
      items.push({
        id: `summary:${summary.id}`,
        value: {
          kind: 'summary',
          id: summary.id,
          message: new SystemMessage(`Context summary:\n${summary.summary}`),
          category: 'summaries',
        },
        estimatedTokens: estimateTextTokens(summary.summary),
        mandatory: false,
        priority: 60,
        recency: order,
        originalOrder: order++,
      });
    }
    for (const group of groups) {
      if (isDuplicateGoal(group, input.job.id, input.originalGoal)) continue;
      const messages = messagesInGroup(group);
      if (maxCoveredRowId > 0 && messages.every(message => message.rowId <= maxCoveredRowId)) continue;
      const recency = Math.max(...messages.map(message => message.rowId));
      items.push({
        id: group.id,
        value: { kind: 'group', group, category: 'messages' },
        estimatedTokens: estimateTextTokens(canonicalJson(messages)),
        mandatory: false,
        priority: groupPriority(group, input),
        recency,
        originalOrder: order++,
      });
    }

    const selection = this.#budget.select(items, input.model);
    const formattedMessages: BaseMessage[] = [];
    const groupIds: string[] = [];
    const summaryIds: string[] = [];
    const breakdown = {
      system: 0,
      tools: 0,
      summaries: 0,
      messages: 0,
      reservedOutput: input.model.reservedOutputTokens,
    };
    for (const item of selection.selected) {
      breakdown[item.value.category] += item.estimatedTokens;
      if (item.value.kind === 'message') formattedMessages.push(item.value.message);
      if (item.value.kind === 'summary') {
        summaryIds.push(item.value.id);
        formattedMessages.push(item.value.message);
      }
      if (item.value.kind === 'group') {
        groupIds.push(item.value.group.id);
        formattedMessages.push(...this.#formatter.formatGroup(item.value.group));
      }
    }
    const selectedRows = selection.selected
      .filter(item => item.value.kind === 'group')
      .flatMap(item => item.value.kind === 'group' ? messagesInGroup(item.value.group) : []);
    const toolSchemaChecksum = toolSchemas.length > 0 ? sha256(canonicalJson(
      toolSchemas.map(tool => ({ name: tool.name, description: tool.description, schema: tool.schema }))
    )) : undefined;
    const fixedPrefixChecksum = sha256(canonicalJson({
      systemPrompt: input.systemPrompt,
      stableContext: input.stableContext,
      originalGoal: input.originalGoal,
      currentInstruction: input.currentInstruction,
      toolSchemaChecksum,
    }));
    const inputManifest: AgentContextInputManifest = {
      purpose: input.purpose,
      contextRulesVersion: CONTEXT_RULES_VERSION,
      systemPromptVersion: input.systemPromptVersion,
      messageGroupIds: groupIds,
      summaryIds,
      ...(selectedRows.length > 0
        ? {
            includedRowIdStart: Math.min(...selectedRows.map(message => message.rowId)),
            includedRowIdEnd: Math.max(...selectedRows.map(message => message.rowId)),
          }
        : {}),
      ...(toolSchemaChecksum ? { toolSchemaChecksum } : {}),
      fixedPrefixChecksum,
      estimatedBreakdown: breakdown,
    };
    return {
      messages: formattedMessages,
      inputManifest,
      estimatedInputTokens: selection.estimatedInputTokens,
      contextRulesVersion: CONTEXT_RULES_VERSION,
      summaryIds,
      compressionRecommended: this.#summaries.shouldCompress({
        purpose: input.purpose,
        candidateTokens: selection.candidateTokens,
        safeInputLimit: selection.safeInputLimit,
        newCompressibleMessageCount: input.newCompressibleMessageCount ?? 0,
        messageThreshold: input.compressionMessageThreshold ?? 50,
      }),
    };
  }
}

function groupPriority(group: MessageGroup, input: BuildContextInput): number {
  const messages = messagesInGroup(group);
  if (input.stepRun && messages[0]?.stepRunId === input.stepRun.id) return 90;
  if (group.type === 'step_output') return 80;
  if (messages[0]?.jobId === input.job.id) return 70;
  return 40;
}

function isDuplicateGoal(group: MessageGroup, jobId: string, goal: string): boolean {
  const messages = messagesInGroup(group);
  return group.type === 'single'
    && messages[0]?.jobId === jobId
    && messages[0]?.messageType === 'user_message'
    && messages[0]?.content === goal;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
