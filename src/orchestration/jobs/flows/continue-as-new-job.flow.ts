import type { CreateJobAndAppendUserMessageResult } from '../../../storage/agent-store.js';
import { JobAttemptStarter } from '../shared/job-attempt-starter.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import { JobStore } from '../shared/job-store.js';

export interface ContinueAsNewJobInput {
  failedJobId: string;
  message: string;
  clientRequestId: string;
}

export class ContinueAsNewJobFlow {
  constructor(
    private readonly jobStore: JobStore,
    private readonly attempts: JobAttemptStarter,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher
  ) {}

  async execute(input: ContinueAsNewJobInput): Promise<CreateJobAndAppendUserMessageResult> {
    const created = await this.jobStore.createContinuationWithMessage({
      failedJobId: input.failedJobId,
      content: input.message,
      clientRequestId: input.clientRequestId,
    });
    await this.events.publishAll([
      { type: 'job.upserted', sessionId: created.job.sessionId, job: created.job },
      { type: 'message.upserted', sessionId: created.job.sessionId, message: created.message },
    ]);
    const running = await this.attempts.start(created.job);
    this.execution.dispatch(running.id);
    return { ...created, job: running };
  }
}
