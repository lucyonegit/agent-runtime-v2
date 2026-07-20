import { createHash, randomUUID } from 'node:crypto';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentJob } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { compileContext, type BuiltContext } from './context-compiler.js';
import type { ContextBundleMaterial, ContextMaterial } from './context-material.js';
import { messagesInGroup } from './message-group-builder.js';

const SESSION_COMPRESSION_PROMPT = `Summarize the supplied completed conversation turns as JSON.
Return exactly one object with schemaVersion=1 and these arrays: userGoals, decisions, planOutcomes, artifacts, unresolved.
planOutcomes entries contain planId, title, summary. artifacts entries may contain path, title, kind.
Preserve identifiers, user constraints, validated plan outcomes and unresolved issues. Do not add facts.`;

interface SessionRollingSummaryV1 {
  schemaVersion: 1;
  sourceBundleIds: string[];
  sourceJobIds: string[];
  sourceRowIdStart: number;
  sourceRowIdEnd: number;
  userGoals: string[];
  decisions: string[];
  planOutcomes: Array<{ planId: string; title: string; summary: string }>;
  artifacts: Array<{ path?: string; title?: string; kind?: string }>;
  unresolved: string[];
}

type SessionCompressionStore = Pick<AgentStore, 'replaceContextSummary'>;

export interface SessionCompressionServiceOptions {
  store: SessionCompressionStore;
  modelName: string;
  clock?: { nowMs(): number };
  ids?: { summaryId(): string };
  retainedRecentBundles?: number;
}

export class SessionCompressionService {
  readonly #clock: { nowMs(): number };
  readonly #ids: { summaryId(): string };
  readonly #retainedRecentBundles: number;

  constructor(private readonly options: SessionCompressionServiceOptions) {
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#ids = options.ids ?? { summaryId: () => `summary_${randomUUID()}` };
    this.#retainedRecentBundles = options.retainedRecentBundles ?? 1;
  }

  async compress(input: {
    job: AgentJob;
    material: ContextMaterial;
    built: BuiltContext;
    invoke(messages: BaseMessage[], built: BuiltContext, logicalCallKey: string): Promise<string>;
  }): Promise<void> {
    if (!input.material.bundles || input.material.bundles.length === 0) return;
    const activeSummaryEnd = Math.max(
      0,
      ...input.material.summaries.map(summary => summary.sourceRowIdEnd ?? 0)
    );
    const eligible = input.material.bundles.filter(item => (
      !item.mustKeep
      && item.bundle.terminal
      && item.bundle.sourceRowIdEnd > activeSummaryEnd
    ));
    const removableCount = Math.max(0, eligible.length - this.#retainedRecentBundles);
    const sourceBundles = eligible.slice(0, removableCount);
    if (sourceBundles.length === 0) return;

    const compressionContext = compileContext(compressionMaterial(input.material, sourceBundles));
    const raw = await input.invoke(
      compressionContext.messages,
      compressionContext,
      `context.compress:session:${input.job.sessionId}:${sourceBundles.at(-1)!.bundle.sourceRowIdEnd}`
    );
    const generated = parseGeneratedSummary(raw);
    const sourceBundleIds = sourceBundles.map(item => item.bundle.id);
    const sourceJobIds = [...new Set(sourceBundles.flatMap(item => item.bundle.jobIds))];
    const sourceRowIdStart = Math.min(...sourceBundles.map(item => item.bundle.sourceRowIdStart));
    const sourceRowIdEnd = Math.max(...sourceBundles.map(item => item.bundle.sourceRowIdEnd));
    const summary: SessionRollingSummaryV1 = {
      schemaVersion: 1,
      sourceBundleIds,
      sourceJobIds,
      sourceRowIdStart,
      sourceRowIdEnd,
      ...generated,
    };
    const serialized = JSON.stringify(summary);
    const sourceMessages = sourceBundles.flatMap(item => (
      item.bundle.groups.flatMap(messagesInGroup)
    ));
    await this.options.store.replaceContextSummary({
      id: this.#ids.summaryId(),
      sessionId: input.job.sessionId,
      jobId: input.job.id,
      ownerType: 'session',
      ownerId: input.job.sessionId,
      purpose: 'conversation',
      contextRulesVersion: input.built.contextRulesVersion,
      summaryType: 'rolling',
      sourceRowIdStart,
      sourceRowIdEnd,
      parentSummaryId: input.material.summaries.at(-1)?.id,
      summary: serialized,
      summaryFormat: 'json',
      sourceMessageCount: sourceMessages.length,
      sourceTokenCount: compressionContext.estimatedInputTokens,
      summaryTokenCount: Math.max(1, Math.ceil(serialized.length / 4)),
      model: this.options.modelName,
      compressionPromptVersion: 'session-rolling-v1',
      checksum: createHash('sha256').update(serialized).digest('hex'),
      metadata: {
        sourceBundleIds,
        sourceJobIds,
        inputManifest: compressionContext.inputManifest,
      },
      nowMs: this.#clock.nowMs(),
    });
  }
}

function compressionMaterial(
  material: ContextMaterial,
  sourceBundles: ContextBundleMaterial[]
): ContextMaterial {
  return {
    ...material,
    fixedMessages: [{
      id: 'must_keep:system',
      message: new SystemMessage(SESSION_COMPRESSION_PROMPT),
      text: SESSION_COMPRESSION_PROMPT,
    }],
    trailingMessages: [],
    fixedPrefix: { systemPrompt: SESSION_COMPRESSION_PROMPT },
    groups: [],
    bundles: sourceBundles.map(item => ({ ...item, mustKeep: true, priority: 1_000 })),
    summaries: [],
    toolSchemas: [],
    audit: {
      purpose: 'context_compression',
      contextRulesVersion: material.audit.contextRulesVersion,
      systemPromptVersion: 'session-rolling-v1',
    },
    compression: {
      disabled: true,
      newCompressibleMessageCount: 0,
      messageThreshold: Number.MAX_SAFE_INTEGER,
    },
  };
}

function parseGeneratedSummary(value: string): Omit<SessionRollingSummaryV1,
  | 'schemaVersion'
  | 'sourceBundleIds'
  | 'sourceJobIds'
  | 'sourceRowIdStart'
  | 'sourceRowIdEnd'> {
  const stripped = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('Session context compression returned invalid JSON.');
  }
  if (!isRecord(parsed)) throw new Error('Session context compression must return an object.');
  const userGoals = stringArray(parsed.userGoals, 'userGoals');
  const decisions = stringArray(parsed.decisions, 'decisions');
  const unresolved = stringArray(parsed.unresolved, 'unresolved');
  if (!Array.isArray(parsed.planOutcomes) || !parsed.planOutcomes.every(isPlanOutcome)) {
    throw new Error('Session context compression returned invalid planOutcomes.');
  }
  if (!Array.isArray(parsed.artifacts) || !parsed.artifacts.every(isArtifact)) {
    throw new Error('Session context compression returned invalid artifacts.');
  }
  return {
    userGoals,
    decisions,
    planOutcomes: parsed.planOutcomes,
    artifacts: parsed.artifacts,
    unresolved,
  };
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`Session context compression returned invalid ${name}.`);
  }
  return value;
}

function isPlanOutcome(value: unknown): value is SessionRollingSummaryV1['planOutcomes'][number] {
  return isRecord(value)
    && typeof value.planId === 'string'
    && typeof value.title === 'string'
    && typeof value.summary === 'string';
}

function isArtifact(value: unknown): value is SessionRollingSummaryV1['artifacts'][number] {
  return isRecord(value)
    && [value.path, value.title, value.kind].every(item => item === undefined || typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
