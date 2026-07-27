import { createHash } from 'node:crypto';
import type { ContextConfig } from '../config/runtime-config.js';
import { mapStoredMessagesToChatMessages } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  ACTIVE_JOB_STATUSES,
  resolveJobGoalMessage,
  type AgentJob,
  type AgentModelCall,
} from '../domain/index.js';
import type { AgentStore } from '../storage/agent-store.js';
import { AgentStoreError } from '../storage/agent-store.js';
import { ReActContextService } from '../runtime/context/react-context.service.js';
import type {
  BuiltContext,
  ContextModelBudget,
} from '../runtime/context/types/context.types.js';
import { RuntimeError } from '../runtime/errors/runtime-error.js';
import { stableStringify } from '../runtime/helpers/stable-json.helper.js';

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

const ACTIVE_JOB_STATUS_SET = new Set<AgentJob['status']>(ACTIVE_JOB_STATUSES);

export type ContextInspectionStore = Pick<AgentStore,
  | 'getSession'
  | 'getJob'
  | 'getModelCall'
  | 'listSessionJobs'
  | 'listSessionMessages'
  | 'listSessionToolInvocations'
  | 'listSessionPlans'
  | 'listSessionPlanSteps'
  | 'listSessionArtifacts'
  | 'listSessionUserInputRequests'
  | 'listActiveContextSummaries'
  | 'listRecentSessionModelCalls'
>;

export interface ContextInspectionServiceOptions {
  store: ContextInspectionStore;
  tools: StructuredToolInterface[];
  model: ContextModelBudget;
  systemPrompt: string;
  systemPromptVersion: string;
  promptId?: string;
  promptVersion?: number;
  getStableContext?: (sessionId: string) => string | undefined;
  contextConfig?: ContextConfig;
  clock?: { nowMs(): number };
}

/** Read-only reconstruction for next-turn, Job and exact ModelCall snapshots. */
export class ContextInspectionService {
  readonly #contexts: ReActContextService;
  readonly #clock: { nowMs(): number };

  constructor(private readonly options: ContextInspectionServiceOptions) {
    this.#contexts = new ReActContextService({
      store: options.store,
      systemPrompt: options.systemPrompt,
      systemPromptVersion: options.systemPromptVersion,
      promptId: options.promptId,
      promptVersion: options.promptVersion,
      model: options.model,
      toolSchemas: options.tools,
      getStableContext: options.getStableContext,
      contextConfig: options.contextConfig,
    });
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
    const jobs = await this.options.store.listSessionJobs(query.sessionId);
    assertNoActiveJob(jobs);
    const preview = await this.#contexts.previewNextTurn(session.id);
    const snapshot = this.#snapshot(query, session.id, preview.built, {
      basedOnLatestJobId: preview.latestJobId,
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
      await this.#contexts.previewJob(job, originalGoal),
      { basedOnLatestJobId: job.id }
    );
  }

  async #modelCall(modelCallId: string, query: ContextQuery): Promise<ContextSnapshot> {
    const call = await this.options.store.getModelCall(modelCallId);
    if (!call) throw new Error(`ModelCall ${JSON.stringify(modelCallId)} was not found.`);
    const built = reconstructRecordedModelCall(call);
    return this.#snapshot(query, call.sessionId, built, {
      basedOnLatestJobId: call.jobId,
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

function assertNoActiveJob(jobs: AgentJob[]): void {
  const active = [...jobs]
    .filter(job => ACTIVE_JOB_STATUS_SET.has(job.status))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  if (!active) return;
  throw new RuntimeError(
    'concurrency_conflict',
    `Context preview is unavailable while Job ${JSON.stringify(active.id)} is ${active.status}.`,
    { details: { jobId: active.id, status: active.status } }
  );
}

function reconstructRecordedModelCall(call: AgentModelCall): BuiltContext {
  const serialized = stableStringify(call.inputMessages);
  const checksum = createHash('sha256').update(serialized).digest('hex');
  if (checksum !== call.inputChecksum) {
    throw new ContextSnapshotUnreconstructableError(
      `ModelCall ${JSON.stringify(call.id)} persisted input checksum is invalid.`
    );
  }
  const messages = mapStoredMessagesToChatMessages(call.inputMessages);
  const prediction = call.inputManifest.tokenPrediction;
  const pressureLevel = prediction?.pressureLevel ?? 'normal';
  return {
    messages,
    inputManifest: call.inputManifest,
    estimatedInputTokens: call.estimatedInputTokens,
    predictedInputTokens: prediction?.predictedInputTokens
      ?? call.estimatedInputTokens,
    predictedCandidateTokens: prediction?.predictedCandidateTokens
      ?? call.estimatedInputTokens,
    hardInputLimit: prediction?.hardInputLimit
      ?? call.maxContextTokens - call.reservedOutputTokens,
    pressureLevel,
    contextRulesVersion: call.inputManifest.contextRulesVersion,
    summaryIds: call.inputManifest.summaryIds,
    mustKeepMessageIds: [],
    compressibleMessageIds: [],
    shouldCompress: ['compact', 'mandatory', 'critical'].includes(pressureLevel),
    mustCompress: ['mandatory', 'critical'].includes(pressureLevel),
    annotations: messages.map((_, index) => ({
      groupId: `model_call:${call.id}:input:${index}`,
    })),
    blockedDiagnostics: [],
  };
}

class ContextSnapshotUnreconstructableError extends Error {
  readonly code = 'context_snapshot_unreconstructable';

  constructor(message: string) {
    super(message);
    this.name = 'ContextSnapshotUnreconstructableError';
  }
}
