import type { JobExecutionSupervisorPort } from '../job-execution-supervisor.js';

/** Fire-and-forget handoff after the durable attempt has been committed. */
export class JobExecutionDispatcher {
  constructor(private readonly execution: JobExecutionSupervisorPort) {}

  dispatch(jobId: string): void {
    void this.execution.startExecution(jobId).catch(() => {
      // The supervisor persists terminal failure while it still owns the Job.
    });
  }
}
