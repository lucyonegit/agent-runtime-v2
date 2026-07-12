import { SystemMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentJob } from '../domain/index.js';
import type { AgentStore } from '../storage/agent-store.js';
import { AgentStoreError } from '../storage/agent-store.js';
import { compileContext, CONTEXT_RULES_VERSION } from '../runtime/context/context-compiler.js';
import type { BuiltContext } from '../runtime/context/context-compiler.js';
import type { ContextMaterial, ContextModelBudget } from '../runtime/context/context-material.js';
import { DirectJobContextLoader } from '../runtime/loaders/direct-job-context-loader.js';
import { ModelCallContextLoader } from '../runtime/loaders/model-call-context-loader.js';
import { SessionContextLoader } from '../runtime/loaders/session-context-loader.js';
import { StepContextLoader } from '../runtime/loaders/step-context-loader.js';
import { resolveJobGoalMessage } from '../runtime/job-goal.js';
import { RuntimeError } from '../runtime/runtime-errors.js';

export type ContextQuery =
  | { kind: 'next_turn'; sessionId: string }
  | { kind: 'job'; jobId: string }
  | { kind: 'step_run'; stepRunId: string }
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
  | 'getStepRun'
  | 'getModelCall'
  | 'getPlanByJobId'
  | 'listPlanSteps'
  | 'listJobStepRuns'
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
  stepSystemPrompt: string;
  compressionMessageThreshold: number;
  clock?: { nowMs(): number };
}

export class ContextInspectionService {
  readonly #session: SessionContextLoader;
  readonly #direct: DirectJobContextLoader;
  readonly #step: StepContextLoader;
  readonly #modelCalls: ModelCallContextLoader;
  readonly #clock: { nowMs(): number };

  constructor(private readonly options: ContextInspectionServiceOptions) {
    this.#session = new SessionContextLoader(options.store);
    this.#direct = new DirectJobContextLoader({
      store: options.store,
      systemPrompt: options.systemPrompt,
      systemPromptVersion: options.systemPromptVersion,
      model: options.model,
      toolSchemas: options.tools,
      compressionMessageThreshold: options.compressionMessageThreshold,
    });
    this.#step = new StepContextLoader({
      store: options.store,
      systemPrompt: options.stepSystemPrompt,
      systemPromptVersion: options.systemPromptVersion,
      model: options.model,
      toolSchemas: options.tools,
      compressionMessageThreshold: options.compressionMessageThreshold,
    });
    this.#modelCalls = new ModelCallContextLoader(options.store);
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async inspect(query: ContextQuery): Promise<ContextSnapshot> {
    switch (query.kind) {
      case 'next_turn':
        return this.#nextTurn(query);
      case 'job':
        return this.#job(query.jobId, query);
      case 'step_run':
        return this.#stepRun(query.stepRunId, query);
      case 'model_call':
        return this.#modelCall(query.modelCallId, query);
    }
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
      fixedPrefix: {
        systemPrompt: this.options.systemPrompt,
        stableContext: undefined,
        originalGoal: undefined,
        currentInstruction: undefined,
      },
      groups: facts.groups.map(group => ({
        group,
        segment: 'session_history',
        mustKeep: false,
        priority: group.type === 'step_output' ? 80 : 40,
      })),
      summaries: [],
      toolSchemas: this.options.tools,
      model: this.options.model,
      audit: {
        purpose: 'job_execution',
        contextRulesVersion: CONTEXT_RULES_VERSION,
        systemPromptVersion: this.options.systemPromptVersion,
      },
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
    if (job.strategy === 'planned') {
      throw new Error(`Planned Job ${job.id} must be inspected through a StepRun or ModelCall.`);
    }
    const originalGoal = await this.#originalGoal(job);
    return this.#snapshot(query, job.sessionId, compileContext(
      await this.#direct.load(job, originalGoal)
    ), { basedOnLatestJobId: job.id });
  }

  async #stepRun(stepRunId: string, query: ContextQuery): Promise<ContextSnapshot> {
    const stepRun = await this.options.store.getStepRun(stepRunId);
    if (!stepRun) throw new Error(`StepRun ${JSON.stringify(stepRunId)} was not found.`);
    const job = await this.#requireJob(stepRun.jobId);
    const plan = await this.options.store.getPlanByJobId(job.id);
    const steps = plan ? await this.options.store.listPlanSteps(plan.id) : [];
    const step = steps.find(candidate => candidate.id === stepRun.stepId);
    if (!step) throw new Error(`StepRun ${stepRun.id} has no PlanStep.`);
    const originalGoal = await this.#originalGoal(job);
    return this.#snapshot(query, job.sessionId, compileContext(await this.#step.load({
      job, originalGoal, step, stepRun,
    })), { basedOnLatestJobId: job.id });
  }

  async #modelCall(modelCallId: string, query: ContextQuery): Promise<ContextSnapshot> {
    const call = await this.#modelCalls.load(modelCallId);
    const job = await this.#requireJob(call.jobId);
    const originalGoal = await this.#originalGoal(job);
    let material: ContextMaterial;
    if (call.stepRunId) {
      const stepRun = await this.options.store.getStepRun(call.stepRunId);
      if (!stepRun) throw new Error(`StepRun ${JSON.stringify(call.stepRunId)} was not found.`);
      const plan = await this.options.store.getPlanByJobId(job.id);
      const steps = plan ? await this.options.store.listPlanSteps(plan.id) : [];
      const step = steps.find(candidate => candidate.id === stepRun.stepId);
      if (!step) throw new Error(`StepRun ${stepRun.id} has no PlanStep.`);
      material = await this.#step.load({ job, originalGoal, step, stepRun });
    } else {
      material = await this.#direct.load(job, originalGoal);
    }
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
    const {
      verification = { status: 'reconstructed' },
      limits = this.options.model,
      ...metadata
    } = options;
    return {
      query,
      generatedAtMs: this.#clock.nowMs(),
      sessionId,
      ...metadata,
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
