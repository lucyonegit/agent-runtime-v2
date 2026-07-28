import type { TaskExecutorPort } from '../task-executor.js';

/** Fire-and-forget handoff after the durable TaskRun has been committed. */
export class TaskExecutionDispatcher {
  constructor(private readonly execution: TaskExecutorPort) {}

  dispatch(taskId: string): void {
    void this.execution.startExecution(taskId).catch(() => {
      // TaskExecutor persists terminal failure while it still owns the Task.
    });
  }
}
