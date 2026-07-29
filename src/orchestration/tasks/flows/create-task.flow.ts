import {
  AgentStoreError,
  type AgentStore,
  type CreateTaskWithUserMessageResult,
} from '../../../storage/agent-store.js';
import { mapStoreError } from '../../../runtime/errors/runtime-error.js';
import { TaskRunStarter } from '../shared/task-run-starter.js';
import { TaskEventPublisher } from '../shared/task-event-publisher.js';
import { TaskExecutionDispatcher } from '../shared/task-execution-dispatcher.js';
import {
  resolveIdempotentTaskCreate,
  type TaskFlowClock,
} from '../shared/task-flow.helper.js';

export interface CreateTaskInput {
  sessionId: string;
  message: string;
  clientRequestId: string;
}

export class CreateTaskFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly clock: TaskFlowClock,
    private readonly nextTaskId: () => string,
    private readonly nextMessageId: () => string,
    private readonly taskRuns: TaskRunStarter,
    private readonly events: TaskEventPublisher,
    private readonly execution: TaskExecutionDispatcher
  ) {}

  async execute(input: CreateTaskInput): Promise<CreateTaskWithUserMessageResult> {
    let created: CreateTaskWithUserMessageResult;
    try {
      created = await this.store.tasks.createWithUserMessage({
        sessionId: input.sessionId,
        taskId: this.nextTaskId(),
        userMessageId: this.nextMessageId(),
        content: input.message,
        clientRequestId: input.clientRequestId,
        nowMs: this.clock.nowMs(),
      });
    } catch (error) {
      if (error instanceof AgentStoreError && error.code === 'CLIENT_REQUEST_CONFLICT') {
        created = await resolveIdempotentTaskCreate(this.store, {
          sessionId: input.sessionId,
          clientRequestId: input.clientRequestId,
          content: input.message,
        });
      } else {
        throw mapStoreError(error);
      }
    }

    await this.events.publishAll([
      { type: 'task.upserted', sessionId: created.task.sessionId, task: created.task },
      { type: 'message.upserted', sessionId: created.task.sessionId, message: created.message },
    ]);
    if (created.task.status !== 'created') return created;

    const started = await this.taskRuns.start(created.task, 'initial');
    this.execution.dispatch({ taskId: started.task.id, taskRunId: started.taskRun.id });
    return { ...created, task: started.task };
  }
}
