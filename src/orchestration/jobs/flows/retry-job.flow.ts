import { withGoalMessageId } from '../../../domain/index.js';
import type { AgentStore, CreateRetryJobResult } from '../../../storage/agent-store.js';
import { mapStoreError } from '../../../runtime/errors/runtime-error.js';
import { JobAttemptStarter } from '../shared/job-attempt-starter.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import { loadRetrySource, type JobFlowClock } from '../shared/job-flow.helper.js';

export interface RetryManagedJobInput {
  failedJobId: string;
  clientRequestId: string;
}

export class RetryJobFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly clock: JobFlowClock,
    private readonly nextJobId: () => string,
    private readonly attempts: JobAttemptStarter,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher
  ) {}

  async execute(input: RetryManagedJobInput): Promise<CreateRetryJobResult> {
    let created: CreateRetryJobResult;
    try {
      const { source, sourceGoalMessageId } = await loadRetrySource(
        this.store,
        input.failedJobId
      );
      created = await this.store.jobs.createRetry({
        sessionId: source.sessionId,
        jobId: this.nextJobId(),
        retryOfJobId: source.id,
        clientRequestId: input.clientRequestId,
        jobMetadata: withGoalMessageId(source.metadata, sourceGoalMessageId),
        nowMs: this.clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    await this.events.publishJob(created.job);
    const running = await this.attempts.start(created.job);
    this.execution.dispatch(running.id);
    return { ...created, job: running };
  }
}
