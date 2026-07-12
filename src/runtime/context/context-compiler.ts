import { createHash } from 'node:crypto';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentContextInputManifest } from '../../domain/index.js';
import { ContextFormatter } from './context-formatter.js';
import type { ContextMaterial } from './context-material.js';
import { messagesInGroup, type MessageGroup } from './message-group-builder.js';
import {
  TokenBudget,
  estimateTextTokens,
  type TokenBudgetItem,
} from './token-budget.js';

export const CONTEXT_RULES_VERSION = 'job-step-run-context-v5';

export interface CompiledContext {
  messages: BaseMessage[];
  inputManifest: AgentContextInputManifest;
  estimatedInputTokens: number;
  contextRulesVersion: string;
  summaryIds: string[];
  mustKeepMessageIds: string[];
  compressibleMessageIds: string[];
  compressionRecommended: boolean;
}

export type BuiltContext = CompiledContext;

type ContextItem =
  | { kind: 'message'; message: BaseMessage; category: 'system' | 'messages' }
  | { kind: 'tools'; category: 'tools' }
  | { kind: 'summary'; id: string; message: BaseMessage; category: 'summaries' }
  | { kind: 'group'; group: MessageGroup; category: 'messages' };

export function compileContext(material: ContextMaterial): CompiledContext {
  const formatter = new ContextFormatter();
  const budget = new TokenBudget();
  const items: Array<TokenBudgetItem<ContextItem>> = [];
  let order = 0;

  for (const fixed of material.fixedMessages) {
    items.push({
      id: fixed.id,
      value: { kind: 'message', message: fixed.message, category: 'system' },
      estimatedTokens: estimateTextTokens(fixed.text),
      mustKeep: true,
      priority: 1_000,
      recency: 0,
      originalOrder: order++,
    });
  }

  const toolSchemas = material.toolSchemas;
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

  const maxCoveredRowId = Math.max(
    0,
    ...material.summaries.map(summary => summary.sourceRowIdEnd ?? 0)
  );
  for (const summary of material.summaries) {
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

  for (const groupMaterial of material.groups) {
    const messages = messagesInGroup(groupMaterial.group);
    if (
      !groupMaterial.mustKeep
      && maxCoveredRowId > 0
      && messages.every(message => message.rowId <= maxCoveredRowId)
    ) continue;
    items.push({
      id: groupMaterial.group.id,
      value: { kind: 'group', group: groupMaterial.group, category: 'messages' },
      estimatedTokens: estimateTextTokens(canonicalJson(messages)),
      mustKeep: groupMaterial.mustKeep,
      priority: groupMaterial.priority,
      recency: Math.max(...messages.map(message => message.rowId)),
      originalOrder: order++,
    });
  }

  for (const trailing of material.trailingMessages ?? []) {
    items.push({
      id: trailing.id,
      value: { kind: 'message', message: trailing.message, category: 'system' },
      estimatedTokens: estimateTextTokens(trailing.text),
      mustKeep: true,
      priority: 1_000,
      recency: Number.MAX_SAFE_INTEGER,
      originalOrder: order++,
    });
  }

  const selection = budget.select(items, material.model);
  const formattedMessages: BaseMessage[] = [];
  const groupIds: string[] = [];
  const summaryIds: string[] = [];
  const breakdown = {
    system: 0,
    tools: 0,
    summaries: 0,
    messages: 0,
    reservedOutput: material.model.reservedOutputTokens,
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
  const explicitCompressionCandidates = material.compression.candidateMessageIds
    ? new Set(material.compression.candidateMessageIds)
    : undefined;
  const compressibleMessageIds = selection.selected
    .filter(item => item.value.kind === 'group' && (
      explicitCompressionCandidates
        ? messagesInGroup(item.value.group).some(message => explicitCompressionCandidates.has(message.id))
        : !item.mustKeep
    ))
    .flatMap(item => item.value.kind === 'group'
      ? messagesInGroup(item.value.group)
        .filter(message => !explicitCompressionCandidates || explicitCompressionCandidates.has(message.id))
        .map(message => message.id)
      : []);
  const toolSchemaChecksum = toolSchemas.length > 0
    ? sha256(canonicalJson(toolSchemas.map(tool => ({
        name: tool.name,
        description: tool.description,
        schema: tool.schema,
      }))))
    : undefined;
  const fixedPrefixChecksum = sha256(canonicalJson({
    ...material.fixedPrefix,
    toolSchemaChecksum,
  }));
  const inputManifest: AgentContextInputManifest = {
    purpose: material.audit.purpose,
    contextRulesVersion: material.audit.contextRulesVersion,
    systemPromptVersion: material.audit.systemPromptVersion,
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
    contextRulesVersion: material.audit.contextRulesVersion,
    summaryIds,
    mustKeepMessageIds,
    compressibleMessageIds,
    compressionRecommended: !material.compression.disabled && (
      selection.candidateTokens > selection.safeInputLimit * 0.7
      || material.compression.newCompressibleMessageCount >= material.compression.messageThreshold
    ),
  };
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
