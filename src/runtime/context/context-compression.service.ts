import { createHash, randomUUID } from 'node:crypto';
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentJob, AgentMessage } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { compileContext, type BuiltContext } from './context-compiler.js';
import type { ContextMaterial } from './context-material.js';
import { messagesInGroup, type MessageGroup } from './message-group-builder.js';
import { estimateTextTokens, resolveInputTokenLimit } from './token-budget.js';
import { ToolResultContextProjector } from './tool-result-context-projector.js';
import {
  CONTEXT_MEMORY_POLICY_COMPONENT_ID,
  CONTEXT_MEMORY_PROMPT_ID,
  CONTEXT_MEMORY_PROMPT_VERSION,
  CONTEXT_MEMORY_SYSTEM_PROMPT,
  CONTEXT_MEMORY_SYSTEM_PROMPT_VERSION,
} from '../prompting/context-memory-prompt.js';
import { createPromptManifest } from '../prompting/prompt-registry.js';

export interface ContextMemoryV1 {
  schemaVersion: 1;
  coverage: {
    groupIds: string[];
    messageIds: string[];
    bundleIds: string[];
    jobIds: string[];
    sourceRowIdStart: number;
    sourceRowIdEnd: number;
  };
  memory: {
    userGoals: Record<string, unknown>[];
    constraints: Record<string, unknown>[];
    facts: Record<string, unknown>[];
    decisions: Record<string, unknown>[];
    completedActions: Record<string, unknown>[];
    failures: Record<string, unknown>[];
    artifacts: Record<string, unknown>[];
    unresolved: Record<string, unknown>[];
  };
}

type ContextCompressionStore = Pick<AgentStore, 'replaceContextSummary'>;

export interface ContextCompressionServiceOptions {
  store: ContextCompressionStore;
  modelName: string;
  clock?: { nowMs(): number };
  ids?: { summaryId(): string };
  recentRawTokenBudget?: number;
  minimumRecentGroups?: number;
}

/**
 * Compacts stable MessageGroups into one session-owned ContextMemory.
 * Job is deliberately not a compression boundary: old groups from the active
 * ReAct loop are eligible once they leave the protected raw tail.
 */
export class ContextCompressionService {
  readonly #clock: { nowMs(): number };
  readonly #ids: { summaryId(): string };

  constructor(private readonly options: ContextCompressionServiceOptions) {
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#ids = options.ids ?? { summaryId: () => `summary_${randomUUID()}` };
  }

  async compress(input: {
    job: AgentJob;
    material: ContextMaterial;
    built?: BuiltContext;
    invoke(messages: BaseMessage[], built: BuiltContext, logicalCallKey: string): Promise<string>;
  }): Promise<boolean> {
    const ordered = orderedGroups(input.material);
    if (ordered.length === 0) return false;

    const activeSummary = input.material.summaries.find(summary => (
      summary.summaryType === 'rolling'
    ));
    const coveredGroupIds = new Set(
      input.material.summaries.flatMap(summary => summary.sourceGroupIds ?? [])
    );
    const protectedMessageIds = new Set(input.material.compression.protectedMessageIds ?? []);
    const uncovered = ordered.filter(item => !coveredGroupIds.has(item.group.id));
    const protectedTail = protectedTailGroupIds(
      uncovered,
      input.material.compression.recentRawTokenBudget
        ?? this.options.recentRawTokenBudget
        ?? 24_000,
      input.material.compression.minimumRecentGroups
        ?? this.options.minimumRecentGroups
        ?? 2
    );
    const eligible = uncovered.filter(item => (
      !protectedTail.has(item.group.id)
      && !messagesInGroup(item.group).some(message => protectedMessageIds.has(message.id))
    ));
    if (eligible.length === 0) return false;

    const previousMemory = parsePreviousMemory(activeSummary?.summary);
    if (activeSummary && !previousMemory) {
      throw new Error(
        `Active rolling summary ${JSON.stringify(activeSummary.id)} is not ContextMemoryV1.`
      );
    }
    const source = compressionBatch(eligible, previousMemory, input.material);
    if (source.length === 0) return false;
    const payload = {
      previousMemory,
      newBlocks: source.map(item => serializeBlock(item.group, item.bundleId)),
    };
    const serializedPayload = JSON.stringify(payload);
    const compressionMaterial = buildCompressionMaterial(input.material, serializedPayload);
    const compressionContext = compileContext(compressionMaterial);
    const lastRowId = Math.max(...source.flatMap(item => (
      messagesInGroup(item.group).map(message => message.rowId)
    )));
    const raw = await input.invoke(
      compressionContext.messages,
      compressionContext,
      `context.compress:${input.job.sessionId}:${lastRowId}`
    );
    const generated = parseGeneratedMemory(raw);

    const previousCoverage = previousMemory?.coverage;
    const sourceMessages = source.flatMap(item => messagesInGroup(item.group));
    const groupIds = unique([
      ...(previousCoverage?.groupIds ?? []),
      ...source.map(item => item.group.id),
    ]);
    const messageIds = unique([
      ...(previousCoverage?.messageIds ?? []),
      ...sourceMessages.map(message => message.id),
    ]);
    const bundleIds = unique([
      ...(previousCoverage?.bundleIds ?? []),
      ...source.map(item => item.bundleId),
    ]);
    const jobIds = unique([
      ...(previousCoverage?.jobIds ?? []),
      ...sourceMessages.map(message => message.jobId),
    ]);
    const sourceRowIdStart = Math.min(
      activeSummary?.sourceRowIdStart ?? Number.MAX_SAFE_INTEGER,
      ...sourceMessages.map(message => message.rowId)
    );
    const sourceRowIdEnd = Math.max(
      activeSummary?.sourceRowIdEnd ?? 0,
      ...sourceMessages.map(message => message.rowId)
    );
    const summary: ContextMemoryV1 = {
      schemaVersion: 1,
      coverage: {
        groupIds,
        messageIds,
        bundleIds,
        jobIds,
        sourceRowIdStart,
        sourceRowIdEnd,
      },
      memory: generated,
    };
    const serialized = JSON.stringify(summary);
    const newSourceTokens = source.reduce(
      (total, item) => total + estimateGroupTokens(item.group),
      0
    );
    await this.options.store.replaceContextSummary({
      id: this.#ids.summaryId(),
      sessionId: input.job.sessionId,
      jobId: input.job.id,
      ownerType: 'session',
      ownerId: input.job.sessionId,
      purpose: 'conversation',
      contextRulesVersion: input.built?.contextRulesVersion
        ?? input.material.audit.contextRulesVersion,
      summaryType: 'rolling',
      sourceRowIdStart,
      sourceRowIdEnd,
      parentSummaryId: activeSummary?.id,
      summary: serialized,
      summaryFormat: 'json',
      sourceMessageCount: messageIds.length,
      sourceTokenCount: (activeSummary?.sourceTokenCount ?? 0) + newSourceTokens,
      summaryTokenCount: estimateTextTokens(serialized),
      model: this.options.modelName,
      compressionPromptVersion: CONTEXT_MEMORY_SYSTEM_PROMPT_VERSION,
      checksum: createHash('sha256').update(serialized).digest('hex'),
      metadata: {
        sourceGroupIds: groupIds,
        sourceBundleIds: bundleIds,
        sourceJobIds: jobIds,
        inputManifest: compressionContext.inputManifest,
      },
      nowMs: this.#clock.nowMs(),
    });
    return true;
  }
}

interface OrderedGroup {
  group: MessageGroup;
  bundleId: string;
}

function orderedGroups(material: ContextMaterial): OrderedGroup[] {
  if (material.bundles) {
    return material.bundles.flatMap(item => (
      item.bundle.groups.map(group => ({ group, bundleId: item.bundle.id }))
    )).sort((left, right) => firstRow(left.group) - firstRow(right.group));
  }
  return material.groups.map(item => ({ group: item.group, bundleId: '' }))
    .sort((left, right) => firstRow(left.group) - firstRow(right.group));
}

function protectedTailGroupIds(
  groups: OrderedGroup[],
  rawTokenBudget: number,
  minimumGroups: number
): Set<string> {
  const protectedIds = new Set<string>();
  let tokens = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const item = groups[index]!;
    const groupTokens = estimateGroupTokens(item.group);
    if (protectedIds.size >= minimumGroups && tokens + groupTokens > rawTokenBudget) break;
    protectedIds.add(item.group.id);
    tokens += groupTokens;
  }
  return protectedIds;
}

function estimateGroupTokens(group: MessageGroup): number {
  return estimateTextTokens(JSON.stringify(serializeBlock(group, '').messages));
}

function serializeBlock(group: MessageGroup, bundleId: string) {
  return {
    groupId: group.id,
    ...(bundleId ? { bundleId } : {}),
    messages: messagesInGroup(group).map(message => serializeMessage(message)),
  };
}

function serializeMessage(message: AgentMessage) {
  const projector = new ToolResultContextProjector();
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

function compressionBatch(
  eligible: OrderedGroup[],
  previousMemory: ContextMemoryV1 | undefined,
  material: ContextMaterial
): OrderedGroup[] {
  const hardLimit = resolveInputTokenLimit(material.model);
  const batchBudget = Math.max(8_000, Math.min(48_000, Math.floor(hardLimit * 0.5)));
  let tokens = estimateTextTokens(JSON.stringify(previousMemory ?? null));
  const selected: OrderedGroup[] = [];
  for (const item of eligible) {
    const groupTokens = estimateGroupTokens(item.group);
    if (selected.length > 0 && tokens + groupTokens > batchBudget) break;
    selected.push(item);
    tokens += groupTokens;
    if (tokens >= batchBudget) break;
  }
  return selected;
}

function buildCompressionMaterial(material: ContextMaterial, payload: string): ContextMaterial {
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

function parsePreviousMemory(value: string | undefined): ContextMemoryV1 | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isContextMemory(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseGeneratedMemory(value: string): ContextMemoryV1['memory'] {
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
    const value = parsed[name];
    if (!Array.isArray(value) || !value.every(isRecord)) {
      throw new Error(`Context compression returned invalid ${name}.`);
    }
    memory[name] = value;
  }
  return memory;
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
