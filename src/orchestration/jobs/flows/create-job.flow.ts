import type { CreateJobAndAppendUserMessageResult } from '../../../storage/agent-store.js';
import { JobAttemptStarter } from '../shared/job-attempt-starter.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import { JobActions } from '../shared/job-actions.js';

export interface CreateManagedJobInput {
  sessionId: string;
  message: string;
  clientRequestId: string;
}

export class CreateJobFlow {
  constructor(
    private readonly jobActions: JobActions,
    private readonly attempts: JobAttemptStarter,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher
  ) {}

  async execute(input: CreateManagedJobInput): Promise<CreateJobAndAppendUserMessageResult> {
    const created = await this.jobActions.createJobWithMessage({
      sessionId: input.sessionId,
      content: input.message,
      clientRequestId: input.clientRequestId,
    });
    await this.events.publishAll([
      { type: 'job.upserted', sessionId: input.sessionId, job: created.job },
      { type: 'message.upserted', sessionId: input.sessionId, message: created.message },
    ]);

    if (created.job.status !== 'created') return created;

    const running = await this.attempts.start(created.job);
    this.execution.dispatch(running.id);
    return { ...created, job: running };
  }
}
