import { createHash, randomUUID } from 'node:crypto';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentJob, AgentContextPurpose } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { compileContext, type BuiltContext } from './context-compiler.js';
import type { ContextMaterial } from './context-material.js';
import { messagesInGroup } from './message-group-builder.js';

const COMPRESSION_PROMPT =
  'Compress the supplied runtime history into a concise factual summary. Preserve decisions, constraints, tool outcomes, unresolved issues, and identifiers. Do not add facts.';

export type ContextCompressionStore = Pick<AgentStore, 'replaceContextSummary'>;

export interface ContextCompressionServiceOptions {
  store: ContextCompressionStore;
  modelName: string;
  clock?: { nowMs(): number };
  ids?: { summaryId(): string };
}

export class ContextCompressionService {
  readonly #clock: { nowMs(): number };
  readonly #ids: { summaryId(): string };

  constructor(private readonly options: ContextCompressionServiceOptions) {
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#ids = options.ids ?? { summaryId: () => `summary_${randomUUID()}` };
  }

  async compress(input: {
    job: AgentJob;
    stepRunId?: string;
    purpose: AgentContextPurpose;
    material: ContextMaterial;
    built: BuiltContext;
    invoke(messages: BaseMessage[], built: BuiltContext, logicalCallKey: string): Promise<string>;
  }): Promise<void> {
    const compressibleIds = new Set(input.built.compressibleMessageIds);
    const sourceGroups = input.material.groups.filter(item => (
      messagesInGroup(item.group).some(message => compressibleIds.has(message.id))
    ));
    const sourceMessages = sourceGroups.flatMap(item => messagesInGroup(item.group));
    if (sourceMessages.length === 0) return;
    const start = Math.min(...sourceMessages.map(message => message.rowId));
    const end = Math.max(...sourceMessages.map(message => message.rowId));
    const retainedFixed = input.material.fixedMessages.filter(item => (
      item.id !== 'must_keep:system'
    ));
    const compressionMaterial: ContextMaterial = {
      ...input.material,
      fixedMessages: [{
        id: 'must_keep:system',
        message: new SystemMessage(COMPRESSION_PROMPT),
        text: COMPRESSION_PROMPT,
      }, ...retainedFixed],
      fixedPrefix: {
        ...input.material.fixedPrefix,
        systemPrompt: COMPRESSION_PROMPT,
      },
      groups: sourceGroups.map(item => ({ ...item, mustKeep: true, priority: 1_000 })),
      bundles: undefined,
      summaries: [],
      audit: {
        ...input.material.audit,
        purpose: 'context_compression',
        systemPromptVersion: 'context-compress-v1',
      },
      compression: {
        disabled: true,
        newCompressibleMessageCount: 0,
        messageThreshold: Number.MAX_SAFE_INTEGER,
      },
    };
    const compressionContext = compileContext(compressionMaterial);
    const summary = (await input.invoke(
      compressionContext.messages,
      compressionContext,
      `context.compress:${input.stepRunId ?? input.job.id}:${end}`
    )).trim();
    if (!summary) throw new Error('Context compression returned an empty summary.');
    await this.options.store.replaceContextSummary({
      id: this.#ids.summaryId(),
      sessionId: input.job.sessionId,
      jobId: input.job.id,
      ...(input.stepRunId ? { stepRunId: input.stepRunId } : {}),
      ownerType: input.stepRunId ? 'step_run' : 'job',
      ownerId: input.stepRunId ?? input.job.id,
      purpose: input.purpose,
      contextRulesVersion: input.built.contextRulesVersion,
      summaryType: input.stepRunId ? 'working_set' : 'job',
      sourceRowIdStart: start,
      sourceRowIdEnd: end,
      parentSummaryId: input.material.summaries.at(-1)?.id,
      summary,
      summaryFormat: 'markdown',
      sourceMessageCount: sourceMessages.length,
      sourceTokenCount: compressionContext.estimatedInputTokens,
      summaryTokenCount: Math.max(1, Math.ceil(summary.length / 4)),
      model: this.options.modelName,
      compressionPromptVersion: 'context-compress-v1',
      checksum: createHash('sha256').update(summary).digest('hex'),
      metadata: { inputManifest: compressionContext.inputManifest },
      nowMs: this.#clock.nowMs(),
    });
  }
}
