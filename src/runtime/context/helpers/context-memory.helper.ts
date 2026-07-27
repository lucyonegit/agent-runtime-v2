import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  DEFAULT_CONTEXT_CONFIG,
  type ContextConfig,
} from '../../../config/runtime-config.js';
import type { AgentMessage } from '../../../domain/index.js';
import {
  CONTEXT_MEMORY_POLICY_COMPONENT_ID,
  CONTEXT_MEMORY_PROMPT_ID,
  CONTEXT_MEMORY_PROMPT_VERSION,
  CONTEXT_MEMORY_SYSTEM_PROMPT,
  CONTEXT_MEMORY_SYSTEM_PROMPT_VERSION,
} from '../../prompting/context-memory-prompt.js';
import { createPromptManifest } from '../../prompting/prompt-registry.js';
import type {
  ContextMaterial,
} from '../types/context.types.js';
import type {
  ContextMemoryV1,
  OrderedContextGroup,
} from '../types/context-memory.types.js';
import type { MessageGroup } from '../types/message-group.types.js';
import { messagesInGroup } from './message-group.helper.js';
import {
  estimateTextTokens,
  resolveInputTokenLimit,
} from './token-budget.helper.js';
import { ToolResultContextProjector } from './tool-result-projector.helper.js';

export function orderedContextGroups(material: ContextMaterial): OrderedContextGroup[] {
  if (material.bundles) {
    return material.bundles.flatMap(item => (
      item.bundle.groups.map(group => ({ group, bundleId: item.bundle.id }))
    )).sort((left, right) => firstRow(left.group) - firstRow(right.group));
  }
  return material.groups.map(item => ({ group: item.group, bundleId: '' }))
    .sort((left, right) => firstRow(left.group) - firstRow(right.group));
}

export function protectedTailGroupIds(
  groups: OrderedContextGroup[],
  rawTokenBudget: number,
  minimumGroups: number
): Set<string> {
  const protectedIds = new Set<string>();
  let tokens = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const item = groups[index]!;
    const groupTokens = estimateContextGroupTokens(item.group);
    if (protectedIds.size >= minimumGroups && tokens + groupTokens > rawTokenBudget) break;
    protectedIds.add(item.group.id);
    tokens += groupTokens;
  }
  return protectedIds;
}

export function selectCompressionBatch(
  eligible: OrderedContextGroup[],
  previousMemory: ContextMemoryV1 | undefined,
  material: ContextMaterial,
  config: ContextConfig = DEFAULT_CONTEXT_CONFIG
): OrderedContextGroup[] {
  const hardLimit = resolveInputTokenLimit(material.model);
  const batchBudget = Math.max(
    config.compression.batchMinimumTokens,
    Math.min(
      config.compression.batchMaximumTokens,
      Math.floor(hardLimit * config.compression.batchInputFraction)
    )
  );
  let tokens = estimateTextTokens(JSON.stringify(previousMemory ?? null));
  const selected: OrderedContextGroup[] = [];
  for (const item of eligible) {
    const groupTokens = estimateContextGroupTokens(item.group);
    if (selected.length > 0 && tokens + groupTokens > batchBudget) break;
    selected.push(item);
    tokens += groupTokens;
    if (tokens >= batchBudget) break;
  }
  return selected;
}

export function buildCompressionMaterial(
  material: ContextMaterial,
  payload: string
): ContextMaterial {
  return {
    ...material,
    fixedMessages: [
      {
        id: 'must_keep:compression_system',
        message: new SystemMessage(CONTEXT_MEMORY_SYSTEM_PROMPT),
        text: CONTEXT_MEMORY_SYSTEM_PROMPT,
      },
      {
        id: 'must_keep:compression_data',
        message: new HumanMessage(payload),
        text: payload,
      },
    ],
    trailingMessages: [],
    fixedPrefix: { systemPrompt: CONTEXT_MEMORY_SYSTEM_PROMPT },
    groups: [],
    bundles: [],
    summaries: [],
    toolSchemas: [],
    audit: {
      purpose: 'context_compression',
      contextRulesVersion: material.audit.contextRulesVersion,
      systemPromptVersion: CONTEXT_MEMORY_SYSTEM_PROMPT_VERSION,
      prompt: createPromptManifest({
        id: CONTEXT_MEMORY_PROMPT_ID,
        version: CONTEXT_MEMORY_PROMPT_VERSION,
        components: [{
          id: CONTEXT_MEMORY_POLICY_COMPONENT_ID,
          version: CONTEXT_MEMORY_PROMPT_VERSION,
          cacheScope: 'stable',
          text: CONTEXT_MEMORY_SYSTEM_PROMPT,
        }],
      }),
    },
    compression: { disabled: true },
  };
}

export function serializeContextGroup(
  group: MessageGroup,
  bundleId: string,
  config: ContextConfig = DEFAULT_CONTEXT_CONFIG
) {
  return {
    groupId: group.id,
    ...(bundleId ? { bundleId } : {}),
    messages: messagesInGroup(group).map(message => serializeMessage(message, config)),
  };
}

export function estimateContextGroupTokens(group: MessageGroup): number {
  return estimateTextTokens(JSON.stringify(serializeContextGroup(group, '').messages));
}

export function parsePreviousContextMemory(
  value: string | undefined
): ContextMemoryV1 | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isContextMemory(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseGeneratedContextMemory(value: string): ContextMemoryV1['memory'] {
  const stripped = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('Context compression returned invalid JSON.');
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error('Context compression must return schemaVersion=1.');
  }
  const names = [
    'userGoals', 'constraints', 'facts', 'decisions', 'completedActions',
    'failures', 'artifacts', 'unresolved',
  ] as const;
  const memory = {} as ContextMemoryV1['memory'];
  for (const name of names) {
    const field = parsed[name];
    if (!Array.isArray(field) || !field.every(isRecord)) {
      throw new Error(`Context compression returned invalid ${name}.`);
    }
    memory[name] = field;
  }
  return memory;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function serializeMessage(message: AgentMessage, config: ContextConfig) {
  const projector = new ToolResultContextProjector({
    maxTokens: config.projection.maximumToolResultTokens,
    headRatio: config.projection.toolResultHeadRatio,
  });
  const projectedContent = message.messageType === 'tool_result'
    ? projector.project(message.content).content
    : message.content;
  const toolCalls = message.toolCalls?.map(call => ({
    id: call.id,
    name: call.name,
    args: projector.project(JSON.stringify(call.args)).content,
  }));
  const toolResult = message.toolResult ? {
    status: message.toolResult.status,
    durationMs: message.toolResult.durationMs,
    error: message.toolResult.error,
  } : undefined;
  return {
    id: message.id,
    rowId: message.rowId,
    jobId: message.jobId,
    role: message.role,
    messageType: message.messageType,
    channel: message.channel,
    content: projectedContent,
    ...(toolCalls ? { toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(toolResult ? { toolResult } : {}),
  };
}

function isContextMemory(value: unknown): value is ContextMemoryV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && isRecord(value.coverage)
    && Array.isArray(value.coverage.groupIds)
    && Array.isArray(value.coverage.messageIds)
    && Array.isArray(value.coverage.bundleIds)
    && Array.isArray(value.coverage.jobIds)
    && isRecord(value.memory);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstRow(group: MessageGroup): number {
  return Math.min(...messagesInGroup(group).map(message => message.rowId));
}
