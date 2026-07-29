import type { AgentStore, CreateTaskWithUserMessageResult } from '../../../storage/agent-store.js';
import { mapStoreError } from '../../../runtime/errors/runtime-error.js';
import { TaskRunStarter } from '../shared/task-run-starter.js';
import { TaskEventPublisher } from '../shared/task-event-publisher.js';
import { TaskExecutionDispatcher } from '../shared/task-execution-dispatcher.js';
import { loadTerminalTask, type TaskFlowClock } from '../shared/task-flow.helper.js';

export interface ContinueAsNewTaskInput {
  sourceTaskId: string;
  message: string;
  clientRequestId: string;
}

/** Continue-as-new creates both a new goal message and a new Task. */
export class ContinueAsNewTaskFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly clock: TaskFlowClock,
    private readonly nextTaskId: () => string,
    private readonly nextMessageId: () => string,
    private readonly taskRuns: TaskRunStarter,
    private readonly events: TaskEventPublisher,
    private readonly execution: TaskExecutionDispatcher
  ) {}

  async execute(input: ContinueAsNewTaskInput): Promise<CreateTaskWithUserMessageResult> {
    try {
      const source = await loadTerminalTask(this.store, input.sourceTaskId);
      const created = await this.store.tasks.createWithUserMessage({
        sessionId: source.sessionId,
        taskId: this.nextTaskId(),
        userMessageId: this.nextMessageId(),
        content: input.message,
        retryOfTaskId: source.id,
        clientRequestId: input.clientRequestId,
        nowMs: this.clock.nowMs(),
      });
      await this.events.publishAll([
        { type: 'task.upserted', sessionId: created.task.sessionId, task: created.task },
        { type: 'message.upserted', sessionId: created.task.sessionId, message: created.message },
      ]);
      const started = await this.taskRuns.start(created.task, 'initial');
      this.execution.dispatch({ taskId: started.task.id, taskRunId: started.taskRun.id });
      return { ...created, task: started.task };
    } catch (error) {
      throw mapStoreError(error);
    }
  }
}
