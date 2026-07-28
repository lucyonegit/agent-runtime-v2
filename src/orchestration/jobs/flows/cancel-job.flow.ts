import type { AgentJob } from '../../../domain/index.js';
import { RuntimeError } from '../../../runtime/errors/runtime-error.js';
import type { JobExecutorPort } from '../job-executor.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobStore } from '../shared/job-store.js';

export class CancelJobFlow {
  constructor(
    private readonly jobStore: JobStore,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutorPort
  ) {}

  async execute(jobId: string, expectedVersion: number): Promise<AgentJob> {
    const cancelled = await this.#cancelLatest(jobId, expectedVersion);
    // Fence future writes before aborting I/O, including drivers that ignore AbortSignal.
    this.execution.abortExecution(cancelled.id);
    await this.events.publishJob(cancelled);
    return cancelled;
  }

  async #cancelLatest(jobId: string, expectedVersion: number): Promise<AgentJob> {
    try {
      return await this.jobStore.cancel(jobId, expectedVersion);
    } catch (error) {
      if (!(error instanceof RuntimeError && error.code === 'concurrency_conflict')) throw error;
      const latest = await this.jobStore.getJob(jobId);
      if (!latest) throw error;
      if (latest.status === 'cancelled') return latest;
      if (![
        'created',
        'running',
        'waiting_user_input',
        'resuming',
        'recovery_required',
      ].includes(latest.status)) throw error;
      return this.jobStore.cancel(jobId, latest.version);
    }
  }
}
