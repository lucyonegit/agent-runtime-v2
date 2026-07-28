import type { JobExecutorPort } from '../job-executor.js';

/** Fire-and-forget handoff after the durable attempt has been committed. */
export class JobExecutionDispatcher {
  constructor(private readonly execution: JobExecutorPort) {}

  dispatch(jobId: string): void {
    void this.execution.startExecution(jobId).catch(() => {
      // JobExecutor persists terminal failure while it still owns the Job.
    });
  }
}
