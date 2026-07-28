import {
  AgentStoreError,
  type AgentStore,
  type CreateRetryTaskResult,
} from '../../../storage/agent-store.js';
import { mapStoreError } from '../../../runtime/errors/runtime-error.js';
import { TaskRunStarter } from '../shared/task-run-starter.js';
import { TaskEventPublisher } from '../shared/task-event-publisher.js';
import { TaskExecutionDispatcher } from '../shared/task-execution-dispatcher.js';
import {
  loadTerminalTask,
  resolveIdempotentTaskRetry,
  type TaskFlowClock,
} from '../shared/task-flow.helper.js';

export interface RetryTaskInput {
  sourceTaskId: string;
  clientRequestId: string;
}

/** Retry is a new logical Task that reuses the source Task's immutable goal message. */
export class RetryTaskFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly clock: TaskFlowClock,
    private readonly nextTaskId: () => string,
    private readonly taskRuns: TaskRunStarter,
    private readonly events: TaskEventPublisher,
    private readonly execution: TaskExecutionDispatcher
  ) {}

  async execute(input: RetryTaskInput): Promise<CreateRetryTaskResult> {
    try {
      const source = await loadTerminalTask(this.store, input.sourceTaskId);
      let created: CreateRetryTaskResult;
      try {
        created = await this.store.tasks.createRetry({
          sessionId: source.sessionId,
          taskId: this.nextTaskId(),
          retryOfTaskId: source.id,
          clientRequestId: input.clientRequestId,
          nowMs: this.clock.nowMs(),
        });
      } catch (error) {
        if (error instanceof AgentStoreError && error.code === 'CLIENT_REQUEST_CONFLICT') {
          created = await resolveIdempotentTaskRetry(this.store, {
            source,
            clientRequestId: input.clientRequestId,
          });
        } else {
          throw error;
        }
      }
      await this.events.publishTask(created.task);
      if (created.task.status !== 'created') return created;

      const started = await this.taskRuns.start(created.task, 'initial');
      this.execution.dispatch(started.task.id);
      return { ...created, task: started.task };
    } catch (error) {
      throw mapStoreError(error);
    }
  }
}
