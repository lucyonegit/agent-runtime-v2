import type { AgentStore } from '../../../storage/agent-store.js';
import type { TaskFlowClock } from './task-flow.helper.js';

export interface ExecutionOwnershipServiceOptions {
  store: AgentStore;
  ownerId: string;
  refreshIntervalMs: number;
  ownershipTimeoutMs: number;
  clock: TaskFlowClock;
}

/** Refreshes a physical TaskRun ownership window while this process executes it. */
export class ExecutionOwnershipService {
  constructor(private readonly options: ExecutionOwnershipServiceOptions) {}

  startRefreshing(taskId: string, taskRunId: string): () => void {
    let refreshInProgress = false;
    const timer = setInterval(() => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      void this.#refresh(taskId, taskRunId).finally(() => {
        refreshInProgress = false;
      });
    }, this.options.refreshIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #refresh(taskId: string, taskRunId: string): Promise<void> {
    const nowMs = this.options.clock.nowMs();
    try {
      await this.options.store.tasks.renewRunOwnership({
        taskId,
        taskRunId,
        ownerId: this.options.ownerId,
        nowMs,
        ownershipExpiresAtMs: nowMs + this.options.ownershipTimeoutMs,
      });
    } catch {
      // The next fenced write detects ownership loss; refresh itself is best-effort.
    }
  }
}
