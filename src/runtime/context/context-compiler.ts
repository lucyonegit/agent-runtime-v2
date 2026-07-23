import { createHash } from 'node:crypto';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentContextInputManifest } from '../../domain/index.js';
import { ContextFormatter } from './context-formatter.js';
import type {
  CompiledContextAnnotation,
  ContextMaterial,
  TurnBundle,
} from './context-material.js';
import { messagesInGroup, type MessageGroup } from './message-group-builder.js';
import {
  TokenBudget,
  estimateTextTokens,
  type TokenBudgetItem,
} from './token-budget.js';

export const CONTEXT_RULES_VERSION = 'unified-react-context-v2';
export const TOKEN_ESTIMATOR_VERSION = 'cjk-aware-v2';
export const CONTEXT_COMPRESSION_START_RATIO = 0.55;
export const CONTEXT_COMPRESSION_REQUIRED_RATIO = 0.75;

export type ContextPressureLevel = 'normal' | 'watch' | 'compact' | 'mandatory' | 'critical';

export interface CompiledContext {
  messages: BaseMessage[];
  inputManifest: AgentContextInputManifest;
  estimatedInputTokens: number;
  predictedInputTokens: number;
  predictedCandidateTokens: number;
  hardInputLimit: number;
  pressureLevel: ContextPressureLevel;
  contextRulesVersion: string;
  summaryIds: string[];
  mustKeepMessageIds: string[];
  compressibleMessageIds: string[];
  shouldCompress: boolean;
  mustCompress: boolean;
  annotations: CompiledContextAnnotation[];
  blockedDiagnostics: NonNullable<ContextMaterial['blockedDiagnostics']>;
}

export type BuiltContext = CompiledContext;

type ContextItem =
  | { kind: 'message'; message: BaseMessage; category: 'system' | 'messages' }
  | { kind: 'tools'; category: 'tools' }
  | { kind: 'summary'; id: string; message: BaseMessage; category: 'summaries' }
  | {
      kind: 'group';
      group: MessageGroup;
      formatted: BaseMessage[];
      truncatedToolResultMessageIds: string[];
      annotations: Array<Omit<CompiledContextAnnotation, 'groupId' | 'bundleId'>>;
      category: 'messages';
    }
  | {
      kind: 'bundle';
      bundle: TurnBundle;
      formatted: Array<{
        group: MessageGroup;
        messages: BaseMessage[];
        truncatedToolResultMessageIds: string[];
        annotations: Array<Omit<CompiledContextAnnotation, 'groupId' | 'bundleId'>>;
      }>;
      category: 'messages';
    };

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

  // A row range is useful for audit but is not an ownership boundary. Exact
  // stable group IDs prevent a summary from hiding unrelated messages that
  // happen to have a smaller row_id (especially inside a long-running Job).
  const coveredGroupIds = new Set(
    material.summaries.flatMap(summary => summary.sourceGroupIds ?? [])
  );
  const mustKeepGroupIds = new Set(
    material.groups.filter(item => item.mustKeep).map(item => item.group.id)
  );
  for (const summary of material.summaries) {
    const summaryText = summary.summaryType === 'rolling'
      ? `Context memory (durable, compressed):\n${summary.summary}`
      : `Context summary:\n${summary.summary}`;
    items.push({
      id: `summary:${summary.id}`,
      value: {
        kind: 'summary',
        id: summary.id,
        message: new SystemMessage(summaryText),
        category: 'summaries',
      },
      estimatedTokens: estimateTextTokens(summaryText),
      // Covered raw groups are no longer present. Dropping their replacement
      // would silently erase history, so active Context Memory is mandatory.
      mustKeep: true,
      priority: 900,
      recency: order,
      originalOrder: order++,
    });
  }

  if (material.bundles) {
    for (const bundleMaterial of material.bundles) {
      const visibleGroups = bundleMaterial.bundle.groups.filter(group => (
        !coveredGroupIds.has(group.id) || mustKeepGroupIds.has(group.id)
      ));
      if (visibleGroups.length === 0) continue;
      const visibleBundle = { ...bundleMaterial.bundle, groups: visibleGroups };
      const formatted = visibleGroups.map(group => {
        const result = formatter.formatGroupWithMetadata(group);
        return { group, ...result };
      });
      items.push({
        id: bundleMaterial.bundle.id,
        value: { kind: 'bundle', bundle: visibleBundle, formatted, category: 'messages' },
        estimatedTokens: estimateTextTokens(canonicalJson(
          formatted.flatMap(item => item.messages.map(message => message.toDict()))
        )),
        mustKeep: bundleMaterial.mustKeep,
        priority: bundleMaterial.priority,
        recency: bundleMaterial.bundle.sourceRowIdEnd,
        originalOrder: order++,
      });
    }
  } else {
    for (const groupMaterial of material.groups) {
      const messages = messagesInGroup(groupMaterial.group);
      if (coveredGroupIds.has(groupMaterial.group.id) && !groupMaterial.mustKeep) continue;
      const formatted = formatter.formatGroupWithMetadata(groupMaterial.group);
      items.push({
        id: groupMaterial.group.id,
        value: {
          kind: 'group',
          group: groupMaterial.group,
          formatted: formatted.messages,
          truncatedToolResultMessageIds: formatted.truncatedToolResultMessageIds,
          annotations: formatted.annotations,
          category: 'messages',
        },
        estimatedTokens: estimateTextTokens(canonicalJson(
          formatted.messages.map(message => message.toDict())
        )),
        mustKeep: groupMaterial.mustKeep,
        priority: groupMaterial.priority,
        recency: Math.max(...messages.map(message => message.rowId)),
        originalOrder: order++,
      });
    }
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

  const bundleItemIds = new Set(items
    .filter(item => item.value.kind === 'bundle')
    .map(item => item.id));
  const selection = material.bundles
    ? budget.selectWithContiguousTail(items, material.model, bundleItemIds)
    : budget.select(items, material.model);
  const formattedMessages: BaseMessage[] = [];
  const groupIds: string[] = [];
  const summaryIds: string[] = [];
  const bundleIds: string[] = [];
  const truncatedToolResultMessageIds: string[] = [];
  const annotations: CompiledContextAnnotation[] = [];
  const breakdown = {
    system: 0,
    tools: 0,
    summaries: 0,
    messages: 0,
    reservedOutput: material.model.reservedOutputTokens,
  };
  for (const item of selection.selected) {
    breakdown[item.value.category] += item.estimatedTokens;
    if (item.value.kind === 'message') {
      formattedMessages.push(item.value.message);
      annotations.push({ groupId: item.id });
    }
    if (item.value.kind === 'summary') {
      summaryIds.push(item.value.id);
      formattedMessages.push(item.value.message);
      annotations.push({ groupId: `summary:${item.value.id}` });
    }
    if (item.value.kind === 'group') {
      groupIds.push(item.value.group.id);
      formattedMessages.push(...item.value.formatted);
      truncatedToolResultMessageIds.push(...item.value.truncatedToolResultMessageIds);
      for (let index = 0; index < item.value.formatted.length; index += 1) {
        annotations.push({
          groupId: item.value.group.id,
          ...item.value.annotations[index],
        });
      }
    }
    if (item.value.kind === 'bundle') {
      bundleIds.push(item.value.bundle.id);
      for (const formatted of item.value.formatted) {
        groupIds.push(formatted.group.id);
        formattedMessages.push(...formatted.messages);
        truncatedToolResultMessageIds.push(...formatted.truncatedToolResultMessageIds);
        for (let index = 0; index < formatted.messages.length; index += 1) {
          annotations.push({
            groupId: formatted.group.id,
            bundleId: item.value.bundle.id,
            ...formatted.annotations[index],
          });
        }
      }
    }
  }

  const selectedRows = selection.selected
    .flatMap(item => {
      if (item.value.kind === 'group') return messagesInGroup(item.value.group);
      if (item.value.kind === 'bundle') return item.value.bundle.groups.flatMap(messagesInGroup);
      return [];
    });
  const mustKeepMessageIds = selection.selected
    .filter(item => item.mustKeep)
    .flatMap(item => {
      if (item.value.kind === 'group') {
        return messagesInGroup(item.value.group).map(message => message.id);
      }
      if (item.value.kind === 'bundle') {
        return item.value.bundle.groups.flatMap(group => (
          messagesInGroup(group).map(message => message.id)
        ));
      }
      return [];
    });
  const explicitCompressionCandidates = material.compression.candidateMessageIds
    ? new Set(material.compression.candidateMessageIds)
    : undefined;
  const compressibleMessageIds = selection.selected
    .flatMap(item => {
      const messages = item.value.kind === 'group'
        ? messagesInGroup(item.value.group)
        : item.value.kind === 'bundle'
          ? item.value.bundle.groups.flatMap(messagesInGroup)
          : [];
      if (messages.length === 0) return [];
      if (explicitCompressionCandidates) {
        return messages.filter(message => explicitCompressionCandidates.has(message.id))
          .map(message => message.id);
      }
      return item.mustKeep ? [] : messages.map(message => message.id);
    });
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
  const inputPressure = compressionDecision(
    selection.predictedCandidateTokens,
    selection.hardInputLimit
  );
  const inputManifest: AgentContextInputManifest = {
    purpose: material.audit.purpose,
    contextRulesVersion: material.audit.contextRulesVersion,
    systemPromptVersion: material.audit.systemPromptVersion,
    ...(material.audit.prompt ? { prompt: material.audit.prompt } : {}),
    messageGroupIds: groupIds,
    summaryIds,
    ...(material.bundles ? { selectedBundleIds: bundleIds } : {}),
    ...(material.bundles ? {
      summarizedBundleIds: material.summaries.flatMap(summary => summary.sourceBundleIds ?? []),
    } : {}),
    ...(coveredGroupIds.size > 0
      ? { summarizedMessageGroupIds: [...coveredGroupIds] }
      : {}),
    ...(truncatedToolResultMessageIds.length > 0
      ? { truncatedToolResultMessageIds: [...new Set(truncatedToolResultMessageIds)] }
      : {}),
    ...(selectedRows.length > 0
      ? {
          includedRowIdStart: Math.min(...selectedRows.map(message => message.rowId)),
          includedRowIdEnd: Math.max(...selectedRows.map(message => message.rowId)),
        }
      : {}),
    ...(toolSchemaChecksum ? { toolSchemaChecksum } : {}),
    fixedPrefixChecksum,
    estimatedBreakdown: breakdown,
    tokenPrediction: {
      estimatorVersion: TOKEN_ESTIMATOR_VERSION,
      calibrationSampleCount: material.model.tokenCalibrationSampleCount ?? 0,
      calibrationFactor: material.model.tokenCalibrationFactor ?? 1,
      errorReserve: material.model.tokenErrorReserve ?? 0,
      rawEstimatedInputTokens: selection.estimatedInputTokens,
      predictedInputTokens: selection.predictedInputTokens,
      predictedCandidateTokens: selection.predictedCandidateTokens,
      hardInputLimit: selection.hardInputLimit,
      pressureLevel: inputPressure.pressureLevel,
    },
  };

  return {
    messages: formattedMessages,
    inputManifest,
    estimatedInputTokens: selection.estimatedInputTokens,
    predictedInputTokens: selection.predictedInputTokens,
    predictedCandidateTokens: selection.predictedCandidateTokens,
    hardInputLimit: selection.hardInputLimit,
    pressureLevel: inputPressure.pressureLevel,
    contextRulesVersion: material.audit.contextRulesVersion,
    summaryIds,
    mustKeepMessageIds,
    compressibleMessageIds,
    shouldCompress: !material.compression.disabled && inputPressure.shouldCompress,
    mustCompress: !material.compression.disabled && inputPressure.mustCompress,
    annotations,
    blockedDiagnostics: material.blockedDiagnostics ?? [],
  };
}

function compressionDecision(
  predictedTokens: number,
  inputTokenLimit: number
): {
  shouldCompress: boolean;
  mustCompress: boolean;
  pressureLevel: ContextPressureLevel;
} {
  const ratio = inputTokenLimit > 0 ? predictedTokens / inputTokenLimit : 1;
  const pressureLevel = ratio >= 0.9
    ? 'critical'
    : ratio >= CONTEXT_COMPRESSION_REQUIRED_RATIO
      ? 'mandatory'
      : ratio >= CONTEXT_COMPRESSION_START_RATIO
        ? 'compact'
        : ratio >= 0.4
          ? 'watch'
          : 'normal';
  return {
    shouldCompress: ratio >= CONTEXT_COMPRESSION_START_RATIO,
    mustCompress: ratio >= CONTEXT_COMPRESSION_REQUIRED_RATIO,
    pressureLevel,
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
