import { createHash } from 'node:crypto';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { ContextFormatter } from './context-formatter.helper.js';
import { ToolResultContextProjector } from './tool-result-projector.helper.js';
import { messagesInGroup } from './message-group.helper.js';
import {
  TokenBudget,
  estimateTextTokens,
} from './token-budget.helper.js';
import type {
  CompiledContextAnnotation,
  ContextMaterial,
  TokenBudgetItem,
  TurnBundle,
} from '../types/context.types.js';
import type { ContextSelection } from '../types/context-compiler.types.js';
import type { MessageGroup } from '../types/message-group.types.js';
import { stableStringify } from '../../helpers/stable-json.helper.js';

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

export function selectContextMaterial(material: ContextMaterial): ContextSelection {
  const items = buildContextItems(material);
  const bundleItemIds = new Set(items
    .filter(item => item.value.kind === 'bundle')
    .map(item => item.id));
  const budget = new TokenBudget();
  const selection = material.bundles
    ? budget.selectWithContiguousTail(items, material.model, bundleItemIds)
    : budget.select(items, material.model);
  const selected = assembleSelectedItems(selection.selected, material);

  return {
    ...selected,
    estimatedInputTokens: selection.estimatedInputTokens,
    predictedInputTokens: selection.predictedInputTokens,
    predictedCandidateTokens: selection.predictedCandidateTokens,
    hardInputLimit: selection.hardInputLimit,
    blockedDiagnostics: material.blockedDiagnostics ?? [],
  };
}

function buildContextItems(material: ContextMaterial): Array<TokenBudgetItem<ContextItem>> {
  const projection = material.contextConfig?.projection;
  const formatter = new ContextFormatter(new ToolResultContextProjector({
    maxTokens: projection?.maximumToolResultTokens,
    headRatio: projection?.toolResultHeadRatio,
  }));
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

  if (material.toolSchemas.length > 0) {
    items.push({
      id: 'must_keep:tools',
      value: { kind: 'tools', category: 'tools' },
      estimatedTokens: estimateTextTokens(serializeToolSchemas(material)),
      mustKeep: true,
      priority: 1_000,
      recency: 0,
      originalOrder: order++,
    });
  }

  const coveredGroupIds = coveredGroupIdsFrom(material);
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
        estimatedTokens: estimateTextTokens(stableStringify(
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
        estimatedTokens: estimateTextTokens(stableStringify(
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

  return items;
}

function assembleSelectedItems(
  selectedItems: Array<TokenBudgetItem<ContextItem>>,
  material: ContextMaterial
): Omit<ContextSelection,
  | 'estimatedInputTokens'
  | 'predictedInputTokens'
  | 'predictedCandidateTokens'
  | 'hardInputLimit'
  | 'blockedDiagnostics'
> {
  const messages: BaseMessage[] = [];
  const groupIds: string[] = [];
  const summaryIds: string[] = [];
  const bundleIds: string[] = [];
  const truncatedToolResultMessageIds: string[] = [];
  const annotations: CompiledContextAnnotation[] = [];
  const estimatedBreakdown = {
    system: 0,
    tools: 0,
    summaries: 0,
    messages: 0,
    reservedOutput: material.model.reservedOutputTokens,
  };

  for (const item of selectedItems) {
    estimatedBreakdown[item.value.category] += item.estimatedTokens;
    if (item.value.kind === 'message') {
      messages.push(item.value.message);
      annotations.push({ groupId: item.id });
    } else if (item.value.kind === 'summary') {
      summaryIds.push(item.value.id);
      messages.push(item.value.message);
      annotations.push({ groupId: `summary:${item.value.id}` });
    } else if (item.value.kind === 'group') {
      const groupItem = item.value;
      groupIds.push(groupItem.group.id);
      messages.push(...groupItem.formatted);
      truncatedToolResultMessageIds.push(...groupItem.truncatedToolResultMessageIds);
      groupItem.formatted.forEach((_message, index) => {
        annotations.push({
          groupId: groupItem.group.id,
          ...groupItem.annotations[index],
        });
      });
    } else if (item.value.kind === 'bundle') {
      const bundleItem = item.value;
      bundleIds.push(bundleItem.bundle.id);
      for (const formatted of bundleItem.formatted) {
        groupIds.push(formatted.group.id);
        messages.push(...formatted.messages);
        truncatedToolResultMessageIds.push(...formatted.truncatedToolResultMessageIds);
        formatted.messages.forEach((_message, index) => {
          annotations.push({
            groupId: formatted.group.id,
            bundleId: bundleItem.bundle.id,
            ...formatted.annotations[index],
          });
        });
      }
    }
  }

  const selectedRows = selectedItems.flatMap(item => {
    if (item.value.kind === 'group') return messagesInGroup(item.value.group);
    if (item.value.kind === 'bundle') return item.value.bundle.groups.flatMap(messagesInGroup);
    return [];
  });
  const mustKeepMessageIds = selectedItems
    .filter(item => item.mustKeep)
    .flatMap(item => messagesForItem(item.value).map(message => message.id));
  const explicitCandidates = material.compression.candidateMessageIds
    ? new Set(material.compression.candidateMessageIds)
    : undefined;
  const compressibleMessageIds = selectedItems.flatMap(item => {
    const itemMessages = messagesForItem(item.value);
    if (explicitCandidates) {
      return itemMessages
        .filter(message => explicitCandidates.has(message.id))
        .map(message => message.id);
    }
    return item.mustKeep ? [] : itemMessages.map(message => message.id);
  });
  const coveredGroupIds = [...coveredGroupIdsFrom(material)];
  const toolSchemaChecksum = material.toolSchemas.length > 0
    ? sha256(serializeToolSchemas(material))
    : undefined;
  const fixedPrefixChecksum = sha256(stableStringify({
    ...material.fixedPrefix,
    toolSchemaChecksum,
  }));

  return {
    messages,
    groupIds,
    summaryIds,
    bundleIds,
    coveredGroupIds,
    truncatedToolResultMessageIds,
    annotations,
    ...(selectedRows.length > 0 ? {
      includedRowIdStart: Math.min(...selectedRows.map(message => message.rowId)),
      includedRowIdEnd: Math.max(...selectedRows.map(message => message.rowId)),
    } : {}),
    ...(toolSchemaChecksum ? { toolSchemaChecksum } : {}),
    fixedPrefixChecksum,
    estimatedBreakdown,
    mustKeepMessageIds,
    compressibleMessageIds,
  };
}

function messagesForItem(item: ContextItem) {
  if (item.kind === 'group') return messagesInGroup(item.group);
  if (item.kind === 'bundle') return item.bundle.groups.flatMap(messagesInGroup);
  return [];
}

function coveredGroupIdsFrom(material: ContextMaterial): Set<string> {
  // Row ranges are audit metadata, not ownership boundaries. Stable group IDs
  // prevent a summary from hiding unrelated rows in a long-running Job.
  return new Set(material.summaries.flatMap(summary => summary.sourceGroupIds ?? []));
}

function serializeToolSchemas(material: ContextMaterial): string {
  return stableStringify(material.toolSchemas.map(tool => ({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
  })));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
