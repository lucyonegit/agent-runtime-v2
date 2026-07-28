import type { AgentJob } from '../../../domain/index.js';
import { JobEventPublisher } from './job-event-publisher.js';
import { JobActions } from './job-actions.js';

/** Starts and publishes one durable JobAttempt; dispatch remains Flow-owned. */
export class JobAttemptStarter {
  constructor(
    private readonly jobActions: JobActions,
    private readonly events: JobEventPublisher
  ) {}

  async start(job: AgentJob): Promise<AgentJob> {
    if (!['created', 'recovery_required'].includes(job.status)) {
      throw new TypeError(`Job ${JSON.stringify(job.id)} cannot start from ${job.status}.`);
    }
    const running = await this.jobActions.startAttempt(job);
    await this.events.publishJob(running);
    return running;
  }
}
