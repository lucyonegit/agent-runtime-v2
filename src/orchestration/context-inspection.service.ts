import { SystemMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentJob } from '../domain/index.js';
import type { AgentStore } from '../storage/agent-store.js';
import { AgentStoreError } from '../storage/agent-store.js';
import { compileContext, CONTEXT_RULES_VERSION } from '../runtime/context/context-compiler.js';
import type { BuiltContext } from '../runtime/context/context-compiler.js';
import type { ContextMaterial, ContextModelBudget } from '../runtime/context/context-material.js';
import { JobContextLoader } from '../runtime/loaders/job-context-loader.js';
import { ModelCallContextLoader } from '../runtime/loaders/model-call-context-loader.js';
import { SessionContextLoader } from '../runtime/loaders/session-context-loader.js';
import { resolveJobGoalMessage } from '../runtime/job-goal.js';
import { RuntimeError } from '../runtime/runtime-errors.js';

export type ContextQuery =
  | { kind: 'next_turn'; sessionId: string }
  | { kind: 'job'; jobId: string }
  | { kind: 'model_call'; modelCallId: string };

export interface ContextSnapshot {
  query: ContextQuery;
  generatedAtMs: number;
  sessionId: string;
  basedOnLatestJobId?: string;
  systemPromptVersion: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  built: BuiltContext;
  verification: { status: 'reconstructed' | 'exact'; checksumMatched?: boolean };
}

const ACTIVE_JOB_STATUSES = new Set<AgentJob['status']>([
  'created', 'running', 'waiting_user_input', 'resuming',
]);

export type ContextInspectionStore = Pick<AgentStore,
  | 'getSession'
  | 'getJob'
  | 'getModelCall'
  | 'listSessionJobs'
  | 'listSessionMessages'
  | 'listSessionToolInvocations'
  | 'listActiveContextSummaries'
>;

export interface ContextInspectionServiceOptions {
  store: ContextInspectionStore;
  tools: StructuredToolInterface[];
  model: ContextModelBudget;
  systemPrompt: string;
  systemPromptVersion: string;
  compressionMessageThreshold: number;
  clock?: { nowMs(): number };
}

/** Read-only reconstruction for next-turn, Job and exact ModelCall snapshots. */
export class ContextInspectionService {
  readonly #session: SessionContextLoader;
  readonly #jobs: JobContextLoader;
  readonly #modelCalls: ModelCallContextLoader;
  readonly #clock: { nowMs(): number };

  constructor(private readonly options: ContextInspectionServiceOptions) {
    this.#session = new SessionContextLoader(options.store);
    this.#jobs = new JobContextLoader({
      store: options.store,
      systemPrompt: options.systemPrompt,
      systemPromptVersion: options.systemPromptVersion,
      model: options.model,
      toolSchemas: options.tools,
      compressionMessageThreshold: options.compressionMessageThreshold,
    });
    this.#modelCalls = new ModelCallContextLoader(options.store);
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async inspect(query: ContextQuery): Promise<ContextSnapshot> {
    if (query.kind === 'next_turn') return this.#nextTurn(query);
    if (query.kind === 'job') return this.#job(query.jobId, query);
    return this.#modelCall(query.modelCallId, query);
  }

  async #nextTurn(query: Extract<ContextQuery, { kind: 'next_turn' }>): Promise<ContextSnapshot> {
    const session = await this.options.store.getSession(query.sessionId);
    if (!session) {
      throw new AgentStoreError(
        'SESSION_NOT_FOUND',
        `Agent session ${JSON.stringify(query.sessionId)} was not found.`
      );
    }
    const [jobs, facts] = await Promise.all([
      this.options.store.listSessionJobs(query.sessionId),
      this.#session.load(query.sessionId),
    ]);
    assertNoActiveJob(jobs);
    const material: ContextMaterial = {
      fixedMessages: [{
        id: 'must_keep:system',
        message: new SystemMessage(this.options.systemPrompt),
        text: this.options.systemPrompt,
      }],
      fixedPrefix: { systemPrompt: this.options.systemPrompt },
      groups: facts.groups.map(group => ({
        group,
        segment: 'session_history',
        mustKeep: false,
        priority: 40,
      })),
      bundles: facts.bundles.map(bundle => ({
        bundle,
        segment: 'session_history',
        mustKeep: false,
        priority: 40,
      })),
      summaries: facts.summaries.map(summary => ({
        id: summary.id,
        summary: summary.summary,
        sourceRowIdEnd: summary.sourceRowIdEnd,
        sourceBundleIds: readStringArray(summary.metadata?.sourceBundleIds),
      })),
      toolSchemas: this.options.tools,
      model: this.options.model,
      audit: {
        purpose: 'job_execution',
        contextRulesVersion: CONTEXT_RULES_VERSION,
        systemPromptVersion: this.options.systemPromptVersion,
      },
      blockedDiagnostics: facts.blocked.map(item => ({
        messageId: item.callMessage.id,
        reason: item.reason,
        ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
      })),
      compression: {
        disabled: false,
        newCompressibleMessageCount: facts.messages.length,
        messageThreshold: this.options.compressionMessageThreshold,
      },
    };
    const snapshot = this.#snapshot(query, session.id, compileContext(material), {
      basedOnLatestJobId: latestJobId(jobs),
    });
    assertNoActiveJob(await this.options.store.listSessionJobs(query.sessionId));
    return snapshot;
  }

  async #job(jobId: string, query: ContextQuery): Promise<ContextSnapshot> {
    const job = await this.#requireJob(jobId);
    const originalGoal = await this.#originalGoal(job);
    return this.#snapshot(
      query,
      job.sessionId,
      compileContext(await this.#jobs.load(job, originalGoal)),
      { basedOnLatestJobId: job.id }
    );
  }

  async #modelCall(modelCallId: string, query: ContextQuery): Promise<ContextSnapshot> {
    const call = await this.#modelCalls.load(modelCallId);
    const job = await this.#requireJob(call.jobId);
    const originalGoal = await this.#originalGoal(job);
    const material = await this.#jobs.load(
      job,
      originalGoal,
      call.inputManifest.contextRulesVersion
    );
    const built = this.#modelCalls.reconstruct(call, material);
    return this.#snapshot(query, job.sessionId, built, {
      basedOnLatestJobId: job.id,
      verification: { status: 'exact', checksumMatched: true },
      limits: {
        maxContextTokens: call.maxContextTokens,
        reservedOutputTokens: call.reservedOutputTokens,
      },
    });
  }

  async #requireJob(jobId: string): Promise<AgentJob> {
    const job = await this.options.store.getJob(jobId);
    if (!job) throw new Error(`Job ${JSON.stringify(jobId)} was not found.`);
    return job;
  }

  async #originalGoal(job: AgentJob): Promise<string> {
    const messages = await this.options.store.listSessionMessages(job.sessionId);
    const goal = resolveJobGoalMessage(job, messages)?.content;
    if (!goal) throw new Error(`Job ${job.id} has no original user goal.`);
    return goal;
  }

  #snapshot(
    query: ContextQuery,
    sessionId: string,
    built: BuiltContext,
    options: {
      basedOnLatestJobId?: string;
      verification?: ContextSnapshot['verification'];
      limits?: { maxContextTokens: number; reservedOutputTokens: number };
    } = {}
  ): ContextSnapshot {
    const verification = options.verification ?? { status: 'reconstructed' as const };
    const limits = options.limits ?? this.options.model;
    return {
      query,
      generatedAtMs: this.#clock.nowMs(),
      sessionId,
      ...(options.basedOnLatestJobId
        ? { basedOnLatestJobId: options.basedOnLatestJobId } : {}),
      systemPromptVersion: built.inputManifest.systemPromptVersion,
      maxContextTokens: limits.maxContextTokens,
      reservedOutputTokens: limits.reservedOutputTokens,
      built,
      verification,
    };
  }
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined;
}

function assertNoActiveJob(jobs: AgentJob[]): void {
  const active = [...jobs]
    .filter(job => ACTIVE_JOB_STATUSES.has(job.status))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  if (!active) return;
  throw new RuntimeError(
    'concurrency_conflict',
    `Context preview is unavailable while Job ${JSON.stringify(active.id)} is ${active.status}.`,
    { details: { jobId: active.id, status: active.status } }
  );
}

function latestJobId(jobs: AgentJob[]): string | undefined {
  return [...jobs].sort((left, right) => (
    right.createdAtMs - left.createdAtMs || right.id.localeCompare(left.id)
  ))[0]?.id;
}
