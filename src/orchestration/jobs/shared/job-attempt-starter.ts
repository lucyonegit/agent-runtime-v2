import type { AgentJob } from '../../../domain/index.js';
import { JobEventPublisher } from './job-event-publisher.js';
import { JobStore } from './job-store.js';

/** Starts and publishes one durable JobAttempt; dispatch remains Flow-owned. */
export class JobAttemptStarter {
  constructor(
    private readonly jobStore: JobStore,
    private readonly events: JobEventPublisher
  ) {}

  async start(job: AgentJob): Promise<AgentJob> {
    if (!['created', 'recovery_required'].includes(job.status)) {
      throw new TypeError(`Job ${JSON.stringify(job.id)} cannot start from ${job.status}.`);
    }
    const running = await this.jobStore.startAttempt(job);
    await this.events.publishJob(running);
    return running;
  }
}
