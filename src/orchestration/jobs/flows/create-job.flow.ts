import { withGoalMessageId } from '../../../domain/index.js';
import {
  AgentStoreError,
  type AgentStore,
  type CreateJobAndAppendUserMessageResult,
} from '../../../storage/agent-store.js';
import { mapStoreError } from '../../../runtime/errors/runtime-error.js';
import { JobAttemptStarter } from '../shared/job-attempt-starter.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import {
  resolveIdempotentJobCreate,
  type JobFlowClock,
} from '../shared/job-flow.helper.js';

export interface CreateManagedJobInput {
  sessionId: string;
  message: string;
  clientRequestId: string;
}

export class CreateJobFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly clock: JobFlowClock,
    private readonly nextJobId: () => string,
    private readonly nextMessageId: () => string,
    private readonly attempts: JobAttemptStarter,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher
  ) {}

  async execute(input: CreateManagedJobInput): Promise<CreateJobAndAppendUserMessageResult> {
    const userMessageId = this.nextMessageId();
    let created: CreateJobAndAppendUserMessageResult;
    try {
      created = await this.store.jobs.createWithUserMessage({
        sessionId: input.sessionId,
        jobId: this.nextJobId(),
        userMessageId,
        content: input.message,
        clientRequestId: input.clientRequestId,
        jobMetadata: withGoalMessageId(undefined, userMessageId),
        nowMs: this.clock.nowMs(),
      });
    } catch (error) {
      if (error instanceof AgentStoreError && error.code === 'CLIENT_REQUEST_CONFLICT') {
        try {
          created = await resolveIdempotentJobCreate(this.store, {
            sessionId: input.sessionId,
            clientRequestId: input.clientRequestId,
            content: input.message,
          });
        } catch (replayError) {
          throw mapStoreError(replayError);
        }
      } else {
        throw mapStoreError(error);
      }
    }
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
