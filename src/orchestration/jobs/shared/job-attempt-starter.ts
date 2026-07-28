import type { AgentJob } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import { mapStoreError } from '../../../runtime/errors/runtime-error.js';
import { JobEventPublisher } from './job-event-publisher.js';
import type { JobFlowClock } from './job-flow.helper.js';

/** Starts and publishes one durable JobAttempt; dispatch remains Flow-owned. */
export class JobAttemptStarter {
  constructor(
    private readonly store: AgentStore,
    private readonly workerId: string,
    private readonly jobLeaseMs: number,
    private readonly clock: JobFlowClock,
    private readonly nextAttemptId: () => string,
    private readonly events: JobEventPublisher
  ) {}

  async start(job: AgentJob): Promise<AgentJob> {
    if (!['created', 'recovery_required'].includes(job.status)) {
      throw new TypeError(`Job ${JSON.stringify(job.id)} cannot start from ${job.status}.`);
    }
    const nowMs = this.clock.nowMs();
    let running: AgentJob;
    try {
      running = await this.store.jobs.startExecution({
        jobId: job.id,
        expectedVersion: job.version,
        workerId: this.workerId,
        attemptId: this.nextAttemptId(),
        nowMs,
        leaseUntilMs: nowMs + this.jobLeaseMs,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    await this.events.publishJob(running);
    return running;
  }
}
