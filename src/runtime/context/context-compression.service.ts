import { createHash, randomUUID } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentJob } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { compileContext } from './context-compiler.js';
import {
  buildCompressionMaterial,
  estimateContextGroupTokens,
  orderedContextGroups,
  parseGeneratedContextMemory,
  parsePreviousContextMemory,
  protectedTailGroupIds,
  selectCompressionBatch,
  serializeContextGroup,
  uniqueStrings,
} from './helpers/context-memory.helper.js';
import { messagesInGroup } from './helpers/message-group.helper.js';
import { estimateTextTokens } from './helpers/token-budget.helper.js';
import {
  CONTEXT_MEMORY_SYSTEM_PROMPT_VERSION,
} from '../prompting/context-memory-prompt.js';
import type {
  BuiltContext,
  ContextMaterial,
} from './types/context.types.js';
import type { ContextMemoryV1 } from './types/context-memory.types.js';

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
    const ordered = orderedContextGroups(input.material);
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

    const previousMemory = parsePreviousContextMemory(activeSummary?.summary);
    if (activeSummary && !previousMemory) {
      throw new Error(
        `Active rolling summary ${JSON.stringify(activeSummary.id)} is not ContextMemoryV1.`
      );
    }
    const source = selectCompressionBatch(eligible, previousMemory, input.material);
    if (source.length === 0) return false;
    const payload = {
      previousMemory,
      newBlocks: source.map(item => serializeContextGroup(item.group, item.bundleId)),
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
    const generated = parseGeneratedContextMemory(raw);

    const previousCoverage = previousMemory?.coverage;
    const sourceMessages = source.flatMap(item => messagesInGroup(item.group));
    const groupIds = uniqueStrings([
      ...(previousCoverage?.groupIds ?? []),
      ...source.map(item => item.group.id),
    ]);
    const messageIds = uniqueStrings([
      ...(previousCoverage?.messageIds ?? []),
      ...sourceMessages.map(message => message.id),
    ]);
    const bundleIds = uniqueStrings([
      ...(previousCoverage?.bundleIds ?? []),
      ...source.map(item => item.bundleId),
    ]);
    const jobIds = uniqueStrings([
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
      (total, item) => total + estimateContextGroupTokens(item.group),
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
