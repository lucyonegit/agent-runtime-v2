import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentJob } from '../domain/index.js';
import { ReactExecution } from '../runtime/execution/react-execution.js';
import { ContextCompressionService } from '../runtime/context/context-compression.service.js';
import { ReActContextService } from '../runtime/context/react-context.service.js';
import { JobLifecycle } from './job-lifecycle.js';
import { resolveJobGoalMessage } from '../runtime/job-goal.js';
import { RuntimeError } from '../runtime/runtime-errors.js';
import type { RuntimeEventPublisher } from '../runtime/runtime-event-writer.js';
import type { RuntimeTool } from '../runtime/execution/tool-executor.js';
import type { AgentStore } from '../storage/agent-store.js';
import { buildStableEnvironmentContext } from '../runtime/prompting/job-agent-prompt.js';

export interface JobExecutionController {
  start(): Promise<void>;
  executeJob(jobId: string): Promise<void>;
  cancelJobExecution(jobId: string): void;
  shutdown(): Promise<void>;
}

export interface JobExecutionManagerOptions {
  store: AgentStore;
  jobLifecycle: JobLifecycle;
  workerId: string;
  publisher: RuntimeEventPublisher;
  model: BaseChatModel;
  provider: string;
  modelName: string;
  tools: RuntimeTool[];
  sandboxRoot?: string;
  maxContextTokens?: number;
  reservedOutputTokens?: number;
  inputTokenLimit?: number;
  maxIterations?: number;
  maxToolCalls?: number;
  executionDeadlineMs?: number;
  jobLeaseMs?: number;
  jobHeartbeatMs?: number;
  recoveryIntervalMs?: number;
  recoveryBatchSize?: number;
  jobSystemPrompt: string;
  systemPromptVersion: string;
  promptId: string;
  promptVersion: number;
  clock?: { nowMs(): number };
}

/**
 * Orchestration owns Job lifecycle, leases and composition. Runtime owns the
 * replaceable ReAct mechanics. Planning is intentionally absent here because
 * it is a durable tool used from inside that one loop.
 */
export class JobExecutionManager implements JobExecutionController {
  readonly #activeExecutions = new Map<string, {
    controller: AbortController;
    completion: Promise<void>;
  }>();
  readonly #options: Required<Omit<JobExecutionManagerOptions,
    'store' | 'publisher' | 'model' | 'tools' | 'workerId' | 'provider' | 'modelName' | 'sandboxRoot'>>
    & JobExecutionManagerOptions;
  readonly #reactExecution: ReactExecution;
  readonly #contextService: ReActContextService;
  readonly #jobLifecycle: JobLifecycle;
  #recoveryTimer?: ReturnType<typeof setInterval>;
  #activeRecoveryScan?: Promise<void>;
  #started = false;
  #stopping = false;

  constructor(options: JobExecutionManagerOptions) {
    const maxContextTokens = options.maxContextTokens ?? 128_000;
    const reservedOutputTokens = options.reservedOutputTokens ?? 4_096;
    const inputTokenLimit = options.inputTokenLimit
      ?? maxContextTokens - reservedOutputTokens;
    this.#options = {
      maxContextTokens,
      reservedOutputTokens,
      inputTokenLimit,
      maxIterations: 24,
      maxToolCalls: 48,
      executionDeadlineMs: 15 * 60_000,
      jobLeaseMs: 30_000,
      jobHeartbeatMs: 10_000,
      recoveryIntervalMs: 5_000,
      recoveryBatchSize: 32,
      clock: { nowMs: () => Date.now() },
      ...options,
    };
    if (this.#options.jobHeartbeatMs >= this.#options.jobLeaseMs) {
      throw new RangeError('jobHeartbeatMs must be shorter than jobLeaseMs.');
    }
    if (!Number.isSafeInteger(this.#options.recoveryIntervalMs)
      || this.#options.recoveryIntervalMs <= 0) {
      throw new RangeError('recoveryIntervalMs must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.#options.recoveryBatchSize)
      || this.#options.recoveryBatchSize <= 0) {
      throw new RangeError('recoveryBatchSize must be a positive integer.');
    }
    const modelBudget = {
      provider: this.#options.provider,
      name: this.#options.modelName,
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
      inputTokenLimit: this.#options.inputTokenLimit,
    };
    this.#jobLifecycle = this.#options.jobLifecycle;
    this.#reactExecution = new ReactExecution({
      store: this.#options.store,
      jobState: this.#jobLifecycle,
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
    this.#contextService = new ReActContextService({
      store: this.#options.store,
      systemPrompt: this.#options.jobSystemPrompt,
      systemPromptVersion: this.#options.systemPromptVersion,
      promptId: this.#options.promptId,
      promptVersion: this.#options.promptVersion,
      model: modelBudget,
      toolSchemas: this.#options.tools.map(tool => tool.tool),
      stableContext: sessionId => buildStableEnvironmentContext({
        sandboxRoot: this.#options.sandboxRoot ?? '.agent-sandbox',
        sessionId,
      }),
      compression: new ContextCompressionService({
        store: this.#options.store,
        modelName: this.#options.modelName,
      }),
      compressionModels: {
        create: ({ job, context, logicalCallKey }) => this.#reactExecution.createAuditedModel(
          job,
          context,
          'context.compress',
          logicalCallKey
        ),
      },
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    try {
      await this.#scanForInterruptedJobs();
      if (this.#stopping) return;
      this.#recoveryTimer = setInterval(() => {
        void this.#scanForInterruptedJobs().catch(() => {
          // The next scan retries transient storage failures.
        });
      }, this.#options.recoveryIntervalMs);
      this.#recoveryTimer.unref();
    } catch (error) {
      this.#started = false;
      throw error;
    }
  }

  async executeJob(jobId: string): Promise<void> {
    if (this.#stopping) return;
    const existingExecution = this.#activeExecutions.get(jobId);
    if (existingExecution) return existingExecution.completion;
    const execution = {
      controller: new AbortController(),
      completion: Promise.resolve(),
    };
    this.#activeExecutions.set(jobId, execution);
    execution.completion = this.#runJobWithLease(jobId, execution.controller.signal).finally(() => {
      if (this.#activeExecutions.get(jobId) === execution) {
        this.#activeExecutions.delete(jobId);
      }
    });
    return execution.completion;
  }

  cancelJobExecution(jobId: string): void {
    this.#activeExecutions.get(jobId)?.controller.abort();
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    if (this.#recoveryTimer) clearInterval(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    await this.#activeRecoveryScan?.catch(() => undefined);
    const activeExecutions = [...this.#activeExecutions.values()];
    for (const execution of activeExecutions) execution.controller.abort('runtime_shutdown');
    await Promise.allSettled(activeExecutions.map(execution => execution.completion));
  }

  async #runJobWithLease(jobId: string, signal: AbortSignal): Promise<void> {
    const stopLeaseHeartbeat = this.#startLeaseHeartbeat(jobId);
    try {
      await this.#executeJob(jobId, signal);
    } catch (error) {
      if (!(error instanceof RuntimeError && ['lease_lost', 'aborted'].includes(error.code))) {
        await this.#failJobIfStillOwned(jobId, error);
      }
    } finally {
      stopLeaseHeartbeat();
    }
  }

  async #executeJob(jobId: string, signal: AbortSignal): Promise<void> {
    const job = await this.#loadRunnableOwnedJob(jobId);
    const messages = await this.#options.store.listSessionMessages(job.sessionId);
    const originalGoal = resolveJobGoalMessage(job, messages)?.content;
    if (!originalGoal) throw new Error(`Job ${job.id} has no original user goal.`);
    await this.#reactExecution.runJob({
      job,
      loadContext: () => this.#contextService.buildForJob(job, originalGoal),
      signal,
    });
  }

  #startLeaseHeartbeat(jobId: string): () => void {
    let leaseRenewalInProgress = false;
    const timer = setInterval(() => {
      if (leaseRenewalInProgress) return;
      leaseRenewalInProgress = true;
      void this.#renewExecutionLease(jobId).finally(() => { leaseRenewalInProgress = false; });
    }, this.#options.jobHeartbeatMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #renewExecutionLease(jobId: string): Promise<void> {
    const job = await this.#options.store.getJob(jobId);
    if (!job || !['running', 'resuming'].includes(job.status)
      || job.leaseOwner !== this.#options.workerId || !job.currentAttemptId) return;
    try {
      // Heartbeats only keep the current execution ownership alive. They are
      // operational bookkeeping, not a user-visible Job state transition.
      await this.#jobLifecycle.renewJobExecutionLease(job);
    } catch {
      // The next fenced write observes the lost lease.
    }
  }

  async #loadRunnableOwnedJob(jobId: string): Promise<AgentJob> {
    const job = await this.#options.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} was not found.`);
    if (!['running', 'resuming'].includes(job.status)
      || job.leaseOwner !== this.#options.workerId
      || !job.currentAttemptId
      || !job.leaseExpiresAtMs
      || job.leaseExpiresAtMs <= this.#options.clock.nowMs()) {
      throw new RuntimeError('lease_lost', `Job ${jobId} is not owned by this worker.`);
    }
    return job;
  }

  #scanForInterruptedJobs(): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    if (this.#activeRecoveryScan) return this.#activeRecoveryScan;

    let scan!: Promise<void>;
    scan = this.#processRecoveryBatch().finally(() => {
      if (this.#activeRecoveryScan === scan) this.#activeRecoveryScan = undefined;
    });
    this.#activeRecoveryScan = scan;
    return scan;
  }

  async #processRecoveryBatch(): Promise<void> {
    const nowMs = this.#options.clock.nowMs();
    await this.#options.store.abandonStartedModelCalls(nowMs);
    const jobsNeedingRecovery = await this.#options.store.listJobsNeedingRuntimeRecovery({
      nowMs,
      createdBeforeMs: nowMs - this.#options.recoveryIntervalMs,
      limit: this.#options.recoveryBatchSize,
    });
    for (const jobNeedingRecovery of jobsNeedingRecovery) {
      if (this.#stopping) break;
      try {
        const recoveryRequiredJob = await this.#jobLifecycle.markJobRecoveryRequired(
          jobNeedingRecovery.id,
          jobNeedingRecovery.version
        );
        await this.#publishWithoutFailingExecution({
          type: 'job.upserted',
          sessionId: recoveryRequiredJob.sessionId,
          job: recoveryRequiredJob,
        });
      } catch (error) {
        if (!(error instanceof RuntimeError
          && ['concurrency_conflict', 'invalid_job_state', 'lease_lost'].includes(error.code))) {
          throw error;
        }
      }
    }
  }

  async #failJobIfStillOwned(jobId: string, error: unknown): Promise<void> {
    const job = await this.#options.store.getJob(jobId);
    if (!job || !job.currentAttemptId || job.leaseOwner !== this.#options.workerId
      || !['running', 'resuming'].includes(job.status)) return;
    try {
      const failedJob = await this.#jobLifecycle.failJob(job, {
        code: error instanceof RuntimeError ? error.code : 'runtime_error',
        message: error instanceof Error ? error.message : 'Runtime execution failed.',
      });
      await this.#publishWithoutFailingExecution({
        type: 'job.upserted',
        sessionId: failedJob.sessionId,
        job: failedJob,
      });
    } catch {
      // A newer owner or terminal transaction won the race.
    }
  }

  async #publishWithoutFailingExecution(
    event: Parameters<RuntimeEventPublisher['publish']>[0]
  ): Promise<void> {
    try {
      await this.#options.publisher.publish(event);
    } catch {
      // SessionView is authoritative when realtime delivery fails.
    }
  }
}
