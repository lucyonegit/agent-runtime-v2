import type { ExecuteTaskRunCommand, TaskExecutorPort } from '../task-executor.js';

/** Fire-and-forget handoff after the durable TaskRun has been committed. */
export class TaskExecutionDispatcher {
  constructor(private readonly execution: TaskExecutorPort) {}

  dispatch(command: ExecuteTaskRunCommand): void {
    void this.execution.execute(command).catch(() => {
      // TaskExecutor persists terminal failure while it still owns the Task.
    });
  }
}
