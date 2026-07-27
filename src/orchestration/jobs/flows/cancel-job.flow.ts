import type { AgentJob } from '../../../domain/index.js';
import { RuntimeError } from '../../../runtime/errors/runtime-error.js';
import type { JobExecutionSupervisorPort } from '../job-execution-supervisor.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobStateTransitions } from '../shared/job-state-transitions.js';

export class CancelJobFlow {
  constructor(
    private readonly state: JobStateTransitions,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionSupervisorPort
  ) {}

  async execute(jobId: string, expectedVersion: number): Promise<AgentJob> {
    const cancelled = await this.#cancelLatest(jobId, expectedVersion);
    // Fence future writes before aborting I/O, including drivers that ignore AbortSignal.
    this.execution.abortExecution(cancelled.id);
    await this.events.publishJob(cancelled);
    return cancelled;
  }

  async #cancelLatest(jobId: string, expectedVersion: number): Promise<AgentJob> {
    try {
      return await this.state.cancel(jobId, expectedVersion);
    } catch (error) {
      if (!(error instanceof RuntimeError && error.code === 'concurrency_conflict')) throw error;
      const latest = await this.state.getJob(jobId);
      if (!latest) throw error;
      if (latest.status === 'cancelled') return latest;
      if (![
        'created',
        'running',
        'waiting_user_input',
        'resuming',
        'recovery_required',
      ].includes(latest.status)) throw error;
      return this.state.cancel(jobId, latest.version);
    }
  }
}
