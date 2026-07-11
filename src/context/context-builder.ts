import { createHash } from 'node:crypto';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type {
  AgentContextInputManifest,
  AgentToolInvocation,
  AgentMessage,
} from '../domain/index.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { ContextFilter } from './context-filter.js';
import { ContextFormatter } from './context-formatter.js';
import {
  CONTEXT_RULES_VERSION,
  type ContextPurpose,
  type ContextScope,
} from './context-purpose.js';
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
  scope: ContextScope;
  purpose: ContextPurpose;
  systemPrompt: string;
  systemPromptVersion: string;
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
  mustKeepMessageIds: string[];
  compressibleMessageIds: string[];
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

export function buildContext(input: BuildContextInput): BuiltContext {
    const groupBuilder = new MessageGroupBuilder();
    const filter = new ContextFilter();
    const formatter = new ContextFormatter();
    const budget = new TokenBudget();
    const summaries = new ContextSummaryManager();
    const builtGroups = groupBuilder.build(input.messages, input.invocations);
    const relevantBlocked = builtGroups.blocked.find(blocked => (
      input.scope.kind !== 'session_history'
      && blocked.callMessage.jobId === input.scope.jobId
      && (input.scope.kind !== 'step_run'
        || blocked.callMessage.stepRunId === input.scope.stepRunId)
    ));
    if (relevantBlocked) {
      throw new IncompleteMessageGroupError(
        `Tool exchange ${JSON.stringify(relevantBlocked.callMessage.id)} is incomplete: ${relevantBlocked.reason}.`
      );
    }
    const groups = filter.filter(builtGroups.groups, {
      purpose: input.purpose === 'context_compression'
        ? input.compressionSourcePurpose ?? 'conversation'
        : input.purpose,
      scope: input.scope,
    });
    const items: Array<TokenBudgetItem<ContextItem>> = [];
    let order = 0;
    const addMustKeepMessage = (id: string, message: BaseMessage, text: string) => {
      items.push({
        id,
        value: { kind: 'message', message, category: 'system' },
        estimatedTokens: estimateTextTokens(text),
        mustKeep: true,
        priority: 1_000,
        recency: 0,
        originalOrder: order++,
      });
    };
    addMustKeepMessage('must_keep:system', new SystemMessage(input.systemPrompt), input.systemPrompt);
    if (input.stableContext) {
      addMustKeepMessage(
        'must_keep:stable',
        new SystemMessage(input.stableContext),
        input.stableContext
      );
    }
    if (input.currentInstruction) {
      addMustKeepMessage(
        'must_keep:instruction',
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
        id: 'must_keep:tools',
        value: { kind: 'tools', category: 'tools' },
        estimatedTokens: estimateTextTokens(serializedTools),
        mustKeep: true,
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
        mustKeep: false,
        priority: 60,
        recency: order,
        originalOrder: order++,
      });
    }
    for (const group of groups) {
      const messages = messagesInGroup(group);
      const mustKeep = isCurrentGoalGroup(group, input.scope);
      if (
        !mustKeep
        && maxCoveredRowId > 0
        && messages.every(message => message.rowId <= maxCoveredRowId)
      ) continue;
      const recency = Math.max(...messages.map(message => message.rowId));
      items.push({
        id: group.id,
        value: { kind: 'group', group, category: 'messages' },
        estimatedTokens: estimateTextTokens(canonicalJson(messages)),
        mustKeep,
        priority: mustKeep ? 1_000 : groupPriority(group, input),
        recency,
        originalOrder: order++,
      });
    }

    const selection = budget.select(items, input.model);
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
        formattedMessages.push(...formatter.formatGroup(item.value.group));
      }
    }
    const selectedRows = selection.selected
      .filter(item => item.value.kind === 'group')
      .flatMap(item => item.value.kind === 'group' ? messagesInGroup(item.value.group) : []);
    const mustKeepMessageIds = selection.selected
      .filter(item => item.mustKeep && item.value.kind === 'group')
      .flatMap(item => item.value.kind === 'group'
        ? messagesInGroup(item.value.group).map(message => message.id)
        : []);
    const compressibleMessageIds = selection.selected
      .filter(item => !item.mustKeep && item.value.kind === 'group')
      .flatMap(item => item.value.kind === 'group'
        ? messagesInGroup(item.value.group).map(message => message.id)
        : []);
    const toolSchemaChecksum = toolSchemas.length > 0 ? sha256(canonicalJson(
      toolSchemas.map(tool => ({ name: tool.name, description: tool.description, schema: tool.schema }))
    )) : undefined;
    const fixedPrefixChecksum = sha256(canonicalJson({
      systemPrompt: input.systemPrompt,
      stableContext: input.stableContext,
      originalGoal: input.scope.kind === 'session_history'
        ? undefined
        : input.scope.originalGoal,
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
      mustKeepMessageIds,
      compressibleMessageIds,
      compressionRecommended: summaries.shouldCompress({
        purpose: input.purpose,
        candidateTokens: selection.candidateTokens,
        safeInputLimit: selection.safeInputLimit,
        newCompressibleMessageCount: input.newCompressibleMessageCount ?? 0,
        messageThreshold: input.compressionMessageThreshold ?? 50,
      }),
    };
}

function groupPriority(group: MessageGroup, input: BuildContextInput): number {
  const messages = messagesInGroup(group);
  if (input.scope.kind === 'step_run' && messages[0]?.stepRunId === input.scope.stepRunId) return 90;
  if (group.type === 'step_output') return 80;
  if (input.scope.kind !== 'session_history' && messages[0]?.jobId === input.scope.jobId) return 70;
  return 40;
}

function isCurrentGoalGroup(group: MessageGroup, scope: ContextScope): boolean {
  if (scope.kind === 'session_history') return false;
  const messages = messagesInGroup(group);
  return group.type === 'single'
    && (scope.originalGoalMessageId
      ? messages[0]?.id === scope.originalGoalMessageId
      : messages[0]?.jobId === scope.jobId
        && messages[0]?.messageType === 'user_message'
        && messages[0]?.content === scope.originalGoal);
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
