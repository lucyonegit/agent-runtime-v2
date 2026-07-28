import type { AgentStore } from '../../../storage/agent-store.js';
import type { JobStore } from './job-store.js';

export interface ExecutionOwnershipServiceOptions {
  store: AgentStore;
  jobStore: JobStore;
  workerId: string;
  refreshIntervalMs: number;
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
    const job = await this.#options.store.getJob(jobId);
    if (!job || !['running', 'resuming'].includes(job.status)
      || job.leaseOwner !== this.#options.workerId || !job.currentAttemptId) return;
    try {
      await this.#options.jobStore.renewExecutionOwnership(job);
    } catch {
      // A later fenced write will observe that execution ownership was lost.
    }
  }
}
