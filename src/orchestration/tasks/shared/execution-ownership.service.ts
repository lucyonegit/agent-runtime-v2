import type { AgentStore } from '../../../storage/agent-store.js';
import { mapStoreError, RuntimeError } from '../../../runtime/errors/runtime-error.js';
import type { TaskFlowClock } from './task-flow.helper.js';

export interface ExecutionOwnershipServiceOptions {
  store: AgentStore;
  ownerId: string;
  refreshIntervalMs: number;
  ownershipTimeoutMs: number;
  clock: TaskFlowClock;
}

export interface ExecutionOwnershipTarget {
  taskId: string;
  taskRunId: string;
  ownershipExpiresAtMs: number;
  onOwnershipLost(error: RuntimeError): void;
}

/** Refreshes a physical TaskRun ownership window while this process executes it. */
export class ExecutionOwnershipService {
  constructor(private readonly options: ExecutionOwnershipServiceOptions) {}

  startRefreshing(target: ExecutionOwnershipTarget): () => void {
    let refreshInProgress = false;
    let stopped = false;
    let ownershipLost = false;
    let confirmedUntilMs = target.ownershipExpiresAtMs;
    let timer: ReturnType<typeof setInterval>;
    const fence = (error: RuntimeError) => {
      if (stopped || ownershipLost) return;
      ownershipLost = true;
      clearInterval(timer);
      try { target.onOwnershipLost(error); } catch { /* ownership is already fenced */ }
    };
    timer = setInterval(() => {
      if (stopped || ownershipLost) return;
      if (this.options.clock.nowMs() >= confirmedUntilMs) {
        fence(new RuntimeError(
          'ownership_lost',
          `TaskRun ${JSON.stringify(target.taskRunId)} ownership was not renewed before its lease expired.`
        ));
        return;
      }
      if (refreshInProgress) return;
      refreshInProgress = true;
      void this.#refresh(target.taskId, target.taskRunId).then(result => {
        if (stopped || ownershipLost) return;
        if (result.type === 'renewed') {
          confirmedUntilMs = result.ownershipExpiresAtMs;
          return;
        }
        if (result.error.code !== 'ownership_lost' && result.checkedAtMs < confirmedUntilMs) {
          return;
        }
        const error = result.error.code === 'ownership_lost'
          ? result.error
          : new RuntimeError(
              'ownership_lost',
              `TaskRun ${JSON.stringify(target.taskRunId)} ownership could not be confirmed before its lease expired.`,
              { cause: result.error }
            );
        fence(error);
      }).finally(() => {
        refreshInProgress = false;
      });
    }, this.options.refreshIntervalMs);
    timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async #refresh(taskId: string, taskRunId: string): Promise<
    | { type: 'renewed'; ownershipExpiresAtMs: number }
    | { type: 'failed'; checkedAtMs: number; error: RuntimeError }
  > {
    const nowMs = this.options.clock.nowMs();
    const ownershipExpiresAtMs = nowMs + this.options.ownershipTimeoutMs;
    try {
      await this.options.store.tasks.renewRunOwnership({
        taskId,
        taskRunId,
        ownerId: this.options.ownerId,
        nowMs,
        ownershipExpiresAtMs,
      });
      return { type: 'renewed', ownershipExpiresAtMs };
    } catch (error) {
      return { type: 'failed', checkedAtMs: nowMs, error: mapStoreError(error) };
    }
  }
}
