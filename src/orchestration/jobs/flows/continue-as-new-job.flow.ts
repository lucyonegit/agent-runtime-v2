import { withGoalMessageId } from '../../../domain/index.js';
import type { AgentStore, CreateJobAndAppendUserMessageResult } from '../../../storage/agent-store.js';
import { mapStoreError } from '../../../runtime/errors/runtime-error.js';
import { JobAttemptStarter } from '../shared/job-attempt-starter.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import { loadRetrySource, type JobFlowClock } from '../shared/job-flow.helper.js';

export interface ContinueAsNewJobInput {
  failedJobId: string;
  message: string;
  clientRequestId: string;
}

export class ContinueAsNewJobFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly clock: JobFlowClock,
    private readonly nextJobId: () => string,
    private readonly nextMessageId: () => string,
    private readonly attempts: JobAttemptStarter,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher
  ) {}

  async execute(input: ContinueAsNewJobInput): Promise<CreateJobAndAppendUserMessageResult> {
    let created: CreateJobAndAppendUserMessageResult;
    try {
      const { source } = await loadRetrySource(this.store, input.failedJobId);
      const userMessageId = this.nextMessageId();
      created = await this.store.jobs.createWithUserMessage({
        sessionId: source.sessionId,
        jobId: this.nextJobId(),
        userMessageId,
        content: input.message,
        retryOfJobId: source.id,
        clientRequestId: input.clientRequestId,
        jobMetadata: withGoalMessageId(source.metadata, userMessageId),
        nowMs: this.clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    await this.events.publishAll([
      { type: 'job.upserted', sessionId: created.job.sessionId, job: created.job },
      { type: 'message.upserted', sessionId: created.job.sessionId, message: created.message },
    ]);
    const running = await this.attempts.start(created.job);
    this.execution.dispatch(running.id);
    return { ...created, job: running };
  }
}
