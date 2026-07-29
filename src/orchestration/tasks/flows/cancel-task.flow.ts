import type { AgentTask } from '../../../domain/index.js';
import { mapStoreError, RuntimeError } from '../../../runtime/errors/runtime-error.js';
import type { AgentStore, FinishTaskResult } from '../../../storage/agent-store.js';
import type { TaskExecutorPort } from '../task-executor.js';
import { TaskEventPublisher } from '../shared/task-event-publisher.js';
import type { TaskFlowClock } from '../shared/task-flow.helper.js';

export class CancelTaskFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly clock: TaskFlowClock,
    private readonly events: TaskEventPublisher,
    private readonly execution: TaskExecutorPort
  ) {}

  async execute(taskId: string, expectedVersion: number): Promise<AgentTask> {
    const result = await this.#cancelLatest(taskId, expectedVersion);
    // The database fence is committed before process-local I/O is aborted.
    this.execution.abortExecution(result.task.id);
    await this.events.publishTaskFinish(result);
    return result.task;
  }

  async #cancelLatest(taskId: string, expectedVersion: number): Promise<FinishTaskResult> {
    try {
      return await this.store.tasks.cancel({
        taskId,
        expectedTaskVersion: expectedVersion,
        nowMs: this.clock.nowMs(),
      });
    } catch (error) {
      const mapped = mapStoreError(error);
      if (!(mapped instanceof RuntimeError && mapped.code === 'concurrency_conflict')) throw mapped;
      const latest = await this.store.tasks.get(taskId);
      if (!latest) throw mapped;
      if (latest.status === 'cancelled') {
        return {
          task: latest,
          toolCalls: [],
          userInputRequests: [],
          planCleared: false,
        };
      }
      if (!['created', 'running', 'waiting_for_user'].includes(latest.status)) {
        throw mapped;
      }
      try {
        return await this.store.tasks.cancel({
          taskId,
          expectedTaskVersion: latest.version,
          nowMs: this.clock.nowMs(),
        });
      } catch (retryError) {
        throw mapStoreError(retryError);
      }
    }
  }
}
