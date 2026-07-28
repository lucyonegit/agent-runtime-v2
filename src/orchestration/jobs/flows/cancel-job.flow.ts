import type { AgentJob } from '../../../domain/index.js';
import { RuntimeError } from '../../../runtime/errors/runtime-error.js';
import type { JobExecutorPort } from '../job-executor.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobActions } from '../shared/job-actions.js';

export class CancelJobFlow {
  constructor(
    private readonly jobActions: JobActions,
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
      return await this.jobActions.cancel(jobId, expectedVersion);
    } catch (error) {
      if (!(error instanceof RuntimeError && error.code === 'concurrency_conflict')) throw error;
      const latest = await this.jobActions.getJob(jobId);
      if (!latest) throw error;
      if (latest.status === 'cancelled') return latest;
      if (![
        'created',
        'running',
        'waiting_user_input',
        'resuming',
        'recovery_required',
      ].includes(latest.status)) throw error;
      return this.jobActions.cancel(jobId, latest.version);
    }
  }
}
