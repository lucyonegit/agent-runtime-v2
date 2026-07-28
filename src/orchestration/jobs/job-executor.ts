import { DEFAULT_EXECUTION_CONFIG } from '../../config/runtime-config.js';
import type { AgentJob } from '../../domain/index.js';
import type { ReActExecution } from '../../runtime/execution/react-execution.js';
import { RuntimeError } from '../../runtime/errors/runtime-error.js';
import type { RuntimeEventPublisher } from '../../runtime/events/runtime-event-writer.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { ExecutionOwnershipService } from './shared/execution-ownership.service.js';
import { InterruptedJobScanner } from './shared/interrupted-job-scanner.js';

export interface JobExecutorPort {
  start(): Promise<void>;
  startExecution(jobId: string): Promise<void>;
  abortExecution(jobId: string): void;
  shutdown(): Promise<void>;
}

export interface JobExecutorOptions {
  store: AgentStore;
  reactExecution: Pick<ReActExecution, 'runJob'>;
  workerId: string;
  publisher: RuntimeEventPublisher;
  ownershipTimeoutMs?: number;
  ownershipRefreshMs?: number;
  recoveryIntervalMs?: number;
  recoveryBatchSize?: number;
  clock?: { nowMs(): number };
}

/**
 * Supervises process-local Job execution: recovery scans, active promises,
 * cancellation and execution ownership heartbeats. User-facing Job commands
 * belong to JobManager; ReAct mechanics remain in Runtime.
 */
export class JobExecutor implements JobExecutorPort {
  readonly #activeExecutions = new Map<string, {
    controller: AbortController;
    completion: Promise<void>;
  }>();
  readonly #options: Required<Omit<JobExecutorOptions,
    'store' | 'reactExecution' | 'publisher' | 'workerId'>>
    & JobExecutorOptions;
  readonly #reactExecution: Pick<ReActExecution, 'runJob'>;
  readonly #executionOwnership: ExecutionOwnershipService;
  readonly #interruptedJobScanner: InterruptedJobScanner;
  #stopping = false;

  constructor(options: JobExecutorOptions) {
    this.#options = {
      ownershipTimeoutMs: DEFAULT_EXECUTION_CONFIG.ownershipTimeoutMs,
      ownershipRefreshMs: DEFAULT_EXECUTION_CONFIG.ownershipRefreshMs,
      recoveryIntervalMs: DEFAULT_EXECUTION_CONFIG.recoveryScanIntervalMs,
      recoveryBatchSize: DEFAULT_EXECUTION_CONFIG.recoveryBatchSize,
      clock: { nowMs: () => Date.now() },
      ...options,
    };
    if (this.#options.ownershipRefreshMs >= this.#options.ownershipTimeoutMs) {
      throw new RangeError('ownershipRefreshMs must be shorter than ownershipTimeoutMs.');
    }
    if (!Number.isSafeInteger(this.#options.recoveryIntervalMs)
      || this.#options.recoveryIntervalMs <= 0) {
      throw new RangeError('recoveryIntervalMs must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.#options.recoveryBatchSize)
      || this.#options.recoveryBatchSize <= 0) {
      throw new RangeError('recoveryBatchSize must be a positive integer.');
    }
    this.#reactExecution = this.#options.reactExecution;
    this.#executionOwnership = new ExecutionOwnershipService({
      store: this.#options.store,
      workerId: this.#options.workerId,
      refreshIntervalMs: this.#options.ownershipRefreshMs,
      ownershipTimeoutMs: this.#options.ownershipTimeoutMs,
      clock: this.#options.clock,
    });
    this.#interruptedJobScanner = new InterruptedJobScanner({
      store: this.#options.store,
      publisher: this.#options.publisher,
      scanIntervalMs: this.#options.recoveryIntervalMs,
      batchSize: this.#options.recoveryBatchSize,
      clock: this.#options.clock,
    });
  }

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#interruptedJobScanner.start();
  }

  async startExecution(jobId: string): Promise<void> {
    if (this.#stopping) return;
    const existingExecution = this.#activeExecutions.get(jobId);
    if (existingExecution) return existingExecution.completion;
    const execution = {
      controller: new AbortController(),
      completion: Promise.resolve(),
    };
    this.#activeExecutions.set(jobId, execution);
    execution.completion = this.#runJobWithExecutionOwnership(
      jobId,
      execution.controller.signal
    ).finally(() => {
      if (this.#activeExecutions.get(jobId) === execution) {
        this.#activeExecutions.delete(jobId);
      }
    });
    return execution.completion;
  }

  abortExecution(jobId: string): void {
    this.#activeExecutions.get(jobId)?.controller.abort();
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    await this.#interruptedJobScanner.stop();
    const activeExecutions = [...this.#activeExecutions.values()];
    for (const execution of activeExecutions) execution.controller.abort('runtime_shutdown');
    await Promise.allSettled(activeExecutions.map(execution => execution.completion));
  }

  async #runJobWithExecutionOwnership(jobId: string, signal: AbortSignal): Promise<void> {
    // Job 执行期间持续刷新执行权有效期；进程退出后刷新自然停止，过期 Job 会进入恢复流程。
    const stopOwnershipRefresh = this.#executionOwnership.startRefreshing(jobId);
    try {
      await this.#executeJob(jobId, signal);
    } catch (error) {
      if (!(error instanceof RuntimeError && ['lease_lost', 'aborted'].includes(error.code))) {
        await this.#failJobIfStillOwned(jobId, error);
      }
    } finally {
      stopOwnershipRefresh();
    }
  }

  async #executeJob(jobId: string, signal: AbortSignal): Promise<void> {
    // 先确认 Job 仍处于可运行状态，并且执行权、Attempt 都属于当前 Worker。
    const job = await this.#loadRunnableOwnedJob(jobId);
    await this.#reactExecution.runJob({
      job,
      signal,
    });
  }

  async #loadRunnableOwnedJob(jobId: string): Promise<AgentJob> {
    const job = await this.#options.store.jobs.get(jobId);
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

  async #failJobIfStillOwned(jobId: string, error: unknown): Promise<void> {
    const job = await this.#options.store.jobs.get(jobId);
    if (!job || !job.currentAttemptId || job.leaseOwner !== this.#options.workerId
      || !['running', 'resuming'].includes(job.status)) return;
    try {
      const failedJob = await this.#options.store.jobs.fail({
        jobId: job.id,
        expectedVersion: job.version,
        workerId: this.#options.workerId,
        attemptId: job.currentAttemptId,
        error: {
          code: error instanceof RuntimeError ? error.code : 'runtime_error',
          message: error instanceof Error ? error.message : 'Runtime execution failed.',
        },
        nowMs: this.#options.clock.nowMs(),
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
