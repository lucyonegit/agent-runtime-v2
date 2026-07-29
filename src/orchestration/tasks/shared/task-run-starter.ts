import type { AgentTask } from '../../../domain/index.js';
import type { AgentStore, StartTaskRunResult } from '../../../storage/agent-store.js';
import { mapStoreError } from '../../../runtime/errors/runtime-error.js';
import { TaskEventPublisher } from './task-event-publisher.js';
import type { TaskFlowClock } from './task-flow.helper.js';

/** Creates one physical TaskRun and publishes both updated durable entities. */
export class TaskRunStarter {
  constructor(
    private readonly store: AgentStore,
    private readonly ownerId: string,
    private readonly ownershipTimeoutMs: number,
    private readonly clock: TaskFlowClock,
    private readonly nextTaskRunId: () => string,
    private readonly events: TaskEventPublisher
  ) {}

  async start(task: AgentTask): Promise<StartTaskRunResult> {
    const nowMs = this.clock.nowMs();
    let result: StartTaskRunResult;
    try {
      result = await this.store.tasks.startRun({
        taskId: task.id,
        expectedTaskVersion: task.version,
        taskRunId: this.nextTaskRunId(),
        trigger: 'initial',
        ownerId: this.ownerId,
        nowMs,
        ownershipExpiresAtMs: nowMs + this.ownershipTimeoutMs,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    await this.events.publishAll([
      { type: 'task.upserted', sessionId: result.task.sessionId, task: result.task },
      { type: 'task_run.upserted', sessionId: result.task.sessionId, taskRun: result.taskRun },
    ]);
    return result;
  }
}
