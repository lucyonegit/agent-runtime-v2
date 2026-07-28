import type { CreateRetryJobResult } from '../../../storage/agent-store.js';
import { JobAttemptStarter } from '../shared/job-attempt-starter.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import { JobStore } from '../shared/job-store.js';

export interface RetryManagedJobInput {
  failedJobId: string;
  clientRequestId: string;
}

export class RetryJobFlow {
  constructor(
    private readonly jobStore: JobStore,
    private readonly attempts: JobAttemptStarter,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher
  ) {}

  async execute(input: RetryManagedJobInput): Promise<CreateRetryJobResult> {
    const created = await this.jobStore.createRetryFromOriginalGoal(input);
    await this.events.publishJob(created.job);
    const running = await this.attempts.start(created.job);
    this.execution.dispatch(running.id);
    return { ...created, job: running };
  }
}
