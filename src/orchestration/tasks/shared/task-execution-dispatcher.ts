import type { ExecuteTaskRunCommand, TaskExecutorPort } from '../task-executor.js';

/** Fire-and-forget handoff after the durable TaskRun has been committed. */
export class TaskExecutionDispatcher {
  constructor(private readonly execution: TaskExecutorPort) {}

  dispatch(command: ExecuteTaskRunCommand): void {
    void this.execution.execute(command).catch(() => {
      // The in-process adapter leaves retry to durable startup recovery.
    });
  }
}
