import type { AgentStore } from '../../../storage/agent-store.js';
import type { JobFlowClock } from './job-flow.helper.js';

export interface ExecutionOwnershipServiceOptions {
  store: AgentStore;
  workerId: string;
  refreshIntervalMs: number;
  ownershipTimeoutMs: number;
  clock: JobFlowClock;
}

/** Keeps the current worker's execution ownership alive while a Job is running. */
export class ExecutionOwnershipService {
  readonly #options: ExecutionOwnershipServiceOptions;

  constructor(options: ExecutionOwnershipServiceOptions) {
    this.#options = options;
  }

  startRefreshing(jobId: string): () => void {
    let refreshInProgress = false;
    const timer = setInterval(() => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      void this.#refresh(jobId).finally(() => {
        refreshInProgress = false;
      });
    }, this.#options.refreshIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #refresh(jobId: string): Promise<void> {
    const job = await this.#options.store.jobs.get(jobId);
    if (!job || !['running', 'resuming'].includes(job.status)
      || job.leaseOwner !== this.#options.workerId || !job.currentAttemptId) return;
    const nowMs = this.#options.clock.nowMs();
    try {
      await this.#options.store.jobs.renewExecutionOwnership({
        jobId: job.id,
        expectedVersion: job.version,
        workerId: this.#options.workerId,
        attemptId: job.currentAttemptId,
        nowMs,
        leaseUntilMs: nowMs + this.#options.ownershipTimeoutMs,
      });
    } catch {
      // A later fenced write will observe that execution ownership was lost.
    }
  }
}
