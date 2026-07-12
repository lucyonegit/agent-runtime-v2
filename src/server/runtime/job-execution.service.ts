import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentJob } from '../../domain/index.js';
import type { JobExecutionService } from '../../orchestration/agent-runtime.js';
import { PlanEngine } from '../../planner/plan-engine.js';
import { PlanSummarizer } from '../../planner/plan-summarizer.js';
import { STEP_OUTPUT_INSTRUCTION } from '../../planner/planner-prompts.js';
import { DirectJobExecutor } from '../../runtime/executors/direct-job-executor.js';
import { PlanExecutor } from '../../runtime/executors/plan-executor.js';
import { ReactExecutor } from '../../runtime/executors/react-executor.js';
import { StepExecutor } from '../../runtime/executors/step-executor.js';
import { DirectJobContextLoader } from '../../runtime/loaders/direct-job-context-loader.js';
import { StepContextLoader } from '../../runtime/loaders/step-context-loader.js';
import { JobCoordinator } from '../../runtime/job-coordinator.js';
import { resolveJobGoalMessage } from '../../runtime/job-goal.js';
import { RuntimeError } from '../../runtime/runtime-errors.js';
import type { RuntimeEventPublisher } from '../../runtime/runtime-event-writer.js';
import type { RuntimeTool } from '../../runtime/tool-executor.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { DefaultPlanner, DefaultPlanSummarizer } from './default-planner.js';
import {
  JOB_EXECUTION_SYSTEM_PROMPT,
  RUNTIME_SYSTEM_PROMPT_VERSION,
  WORKSPACE_TOOL_ROUTING_INSTRUCTION,
} from './runtime-context-config.js';

export interface RuntimeJobExecutionOptions {
  store: AgentStore;
  workerId: string;
  publisher: RuntimeEventPublisher;
  model: BaseChatModel;
  provider: string;
  modelName: string;
  tools: RuntimeTool[];
  sandboxRoot?: string;
  maxContextTokens?: number;
  reservedOutputTokens?: number;
  maxIterations?: number;
  maxToolCalls?: number;
  executionDeadlineMs?: number;
  jobLeaseMs?: number;
  jobHeartbeatMs?: number;
  compressionMessageThreshold?: number;
}

export class RuntimeJobExecutionService implements JobExecutionService {
  readonly #running = new Set<string>();
  readonly #options: Required<Omit<RuntimeJobExecutionOptions,
    'store' | 'publisher' | 'model' | 'tools' | 'workerId' | 'provider' | 'modelName' | 'sandboxRoot'>>
    & RuntimeJobExecutionOptions;
  readonly #react: ReactExecutor;
  readonly #directContext: DirectJobContextLoader;
  readonly #directExecutor: DirectJobExecutor;
  readonly #planExecutor: PlanExecutor;

  constructor(options: RuntimeJobExecutionOptions) {
    this.#options = {
      maxContextTokens: 128_000,
      reservedOutputTokens: 4_096,
      maxIterations: 24,
      maxToolCalls: 48,
      executionDeadlineMs: 15 * 60_000,
      jobLeaseMs: 20 * 60_000,
      jobHeartbeatMs: 60_000,
      compressionMessageThreshold: 50,
      ...options,
    };
    if (this.#options.jobHeartbeatMs >= this.#options.jobLeaseMs) {
      throw new RangeError('jobHeartbeatMs must be shorter than jobLeaseMs.');
    }
    const modelBudget = {
      provider: this.#options.provider,
      name: this.#options.modelName,
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
    };
    const toolSchemas = this.#options.tools.map(tool => tool.tool);
    this.#directContext = new DirectJobContextLoader({
      store: this.#options.store,
      systemPrompt: JOB_EXECUTION_SYSTEM_PROMPT,
      systemPromptVersion: RUNTIME_SYSTEM_PROMPT_VERSION,
      model: modelBudget,
      toolSchemas,
      compressionMessageThreshold: this.#options.compressionMessageThreshold,
    });
    const stepContexts = new StepContextLoader({
      store: this.#options.store,
      systemPrompt: `Execute only the current PlanStep. ${WORKSPACE_TOOL_ROUTING_INSTRUCTION} ${STEP_OUTPUT_INSTRUCTION}`,
      systemPromptVersion: RUNTIME_SYSTEM_PROMPT_VERSION,
      model: modelBudget,
      toolSchemas,
      compressionMessageThreshold: this.#options.compressionMessageThreshold,
    });
    this.#react = new ReactExecutor({
      store: this.#options.store,
      workerId: this.#options.workerId,
      publisher: this.#options.publisher,
      model: this.#options.model,
      provider: this.#options.provider,
      modelName: this.#options.modelName,
      tools: this.#options.tools,
      sandboxRoot: this.#options.sandboxRoot,
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
      maxIterations: this.#options.maxIterations,
      maxToolCalls: this.#options.maxToolCalls,
      executionDeadlineMs: this.#options.executionDeadlineMs,
    });
    this.#directExecutor = new DirectJobExecutor(
      this.#react,
      this.#directContext,
      this.#options.publisher
    );
    this.#planExecutor = new PlanExecutor({
      store: this.#options.store,
      stepExecutor: new StepExecutor(this.#react, stepContexts),
      requireOwnedJob: jobId => this.#requireOwnedJob(jobId),
    });
  }

  async execute(jobId: string): Promise<void> {
    if (this.#running.has(jobId)) return;
    this.#running.add(jobId);
    const stopHeartbeat = this.#startHeartbeat(jobId);
    try {
      await this.#executeOwnedJob(jobId);
    } catch (error) {
      if (!(error instanceof RuntimeError && error.code === 'lease_lost')) {
        await this.#failIfOwned(jobId, error);
      }
    } finally {
      stopHeartbeat();
      this.#running.delete(jobId);
    }
  }

  async #executeOwnedJob(jobId: string): Promise<void> {
    let job = await this.#requireOwnedJob(jobId);
    const messages = await this.#options.store.listSessionMessages(job.sessionId);
    const goalMessage = resolveJobGoalMessage(job, messages);
    const originalGoal = goalMessage?.content;
    if (!originalGoal) throw new Error(`Job ${job.id} has no original user goal.`);
    const jobContext = await this.#react.buildContext(
      job,
      'job_execution',
      undefined,
      () => this.#directContext.load(job, originalGoal)
    );
    const planner = this.#createPlanEngine(job, jobContext);

    if (!job.strategy || job.stage === 'planning' && !await this.#options.store.getPlanByJobId(job.id)) {
      const routed = await planner.route(job, originalGoal, {
        ...currentTemporalContext(),
        availableTools: this.#options.tools.map(item => item.tool.name),
      });
      job = routed.job;
      if (routed.strategy === 'planned' && 'plan' in routed) job = routed.job;
    }
    if (job.strategy === 'direct') {
      await this.#directExecutor.execute(job, originalGoal);
      return;
    }
    await this.#planExecutor.execute(job, originalGoal, planner);
  }

  #createPlanEngine(job: AgentJob, built: Awaited<ReturnType<ReactExecutor['buildContext']>>): PlanEngine {
    const route = this.#react.createAuditedModel(job, built, 'planner.route', 'planner.route');
    const create = this.#react.createAuditedModel(job, built, 'planner.create', 'planner.create');
    const finalize = this.#react.createAuditedModel(job, built, 'plan.finalize', 'plan.finalize');
    return new PlanEngine({
      store: this.#options.store,
      workerId: this.#options.workerId,
      planner: new DefaultPlanner(route, create),
      summarizer: new PlanSummarizer(new DefaultPlanSummarizer(finalize)),
      publisher: this.#options.publisher,
    });
  }

  #startHeartbeat(jobId: string): () => void {
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.#renewLease(jobId).finally(() => { renewing = false; });
    }, this.#options.jobHeartbeatMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #renewLease(jobId: string): Promise<void> {
    const job = await this.#options.store.getJob(jobId);
    if (!job || !['running', 'resuming'].includes(job.status)
      || job.leaseOwner !== this.#options.workerId || !job.currentAttemptId) return;
    try {
      const coordinator = new JobCoordinator({
        store: this.#options.store,
        workerId: this.#options.workerId,
        limits: {
          jobLeaseMs: this.#options.jobLeaseMs,
          jobHeartbeatMs: this.#options.jobHeartbeatMs,
        },
      });
      const renewed = await coordinator.renewJobLease(job);
      await this.#safePublish({ type: 'job.upserted', sessionId: renewed.sessionId, job: renewed });
    } catch {
      // The next fenced write observes a lost lease and stops this execution.
    }
  }

  async #requireOwnedJob(jobId: string): Promise<AgentJob> {
    const job = await this.#options.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} was not found.`);
    if (!['running', 'resuming'].includes(job.status)
      || job.leaseOwner !== this.#options.workerId
      || !job.currentAttemptId
      || !job.leaseExpiresAtMs
      || job.leaseExpiresAtMs <= Date.now()) {
      throw new RuntimeError('lease_lost', `Job ${jobId} is not owned by this worker.`);
    }
    return job;
  }

  async #failIfOwned(jobId: string, error: unknown): Promise<void> {
    const job = await this.#options.store.getJob(jobId);
    if (!job || !job.currentAttemptId || job.leaseOwner !== this.#options.workerId
      || !['running', 'resuming'].includes(job.status)) return;
    const coordinator = new JobCoordinator({
      store: this.#options.store,
      workerId: this.#options.workerId,
    });
    try {
      const failed = await coordinator.failJob(job, {
        code: error instanceof RuntimeError ? error.code : 'runtime_error',
        message: error instanceof Error ? error.message : 'Runtime execution failed.',
      });
      await this.#safePublish({ type: 'job.upserted', sessionId: failed.sessionId, job: failed });
    } catch {
      // A newer owner or terminal transaction won the race.
    }
  }

  async #safePublish(event: Parameters<RuntimeEventPublisher['publish']>[0]): Promise<void> {
    try {
      await this.#options.publisher.publish(event);
    } catch {
      // The durable SessionView remains authoritative when realtime delivery fails.
    }
  }
}

function currentTemporalContext(): { currentDate: string; timezone: string } {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { currentDate: `${values.year}-${values.month}-${values.day}`, timezone };
}
