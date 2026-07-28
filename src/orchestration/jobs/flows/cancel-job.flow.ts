import type { AgentJob } from '../../../domain/index.js';
import { mapStoreError, RuntimeError } from '../../../runtime/errors/runtime-error.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import type { JobExecutorPort } from '../job-executor.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import type { JobFlowClock } from '../shared/job-flow.helper.js';

export class CancelJobFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly clock: JobFlowClock,
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
      return await this.store.jobs.cancel({
        jobId,
        expectedVersion,
        nowMs: this.clock.nowMs(),
      });
    } catch (error) {
      const mappedError = mapStoreError(error);
      if (!(mappedError instanceof RuntimeError
        && mappedError.code === 'concurrency_conflict')) throw mappedError;
      let latest: AgentJob | undefined;
      try {
        latest = await this.store.jobs.get(jobId);
      } catch (readError) {
        throw mapStoreError(readError);
      }
      if (!latest) throw mappedError;
      if (latest.status === 'cancelled') return latest;
      if (![
        'created',
        'running',
        'waiting_user_input',
        'resuming',
        'recovery_required',
      ].includes(latest.status)) throw mappedError;
      try {
        return await this.store.jobs.cancel({
          jobId,
          expectedVersion: latest.version,
          nowMs: this.clock.nowMs(),
        });
      } catch (retryError) {
        throw mapStoreError(retryError);
      }
    }
  }
}
