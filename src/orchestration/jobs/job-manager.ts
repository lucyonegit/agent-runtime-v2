import type { AgentJob } from '../../domain/index.js';
import type {
  AgentStore,
  CreateJobAndAppendUserMessageResult,
  CreateRetryJobResult,
  SaveUserInputAnswerResult,
} from '../../storage/agent-store.js';
import type { RuntimeEventPublisher } from '../../runtime/events/runtime-event-writer.js';
import {
  AnswerUserInputFlow,
  type AnswerUserInputRequestInput,
} from './flows/answer-user-input.flow.js';
import { CancelJobFlow } from './flows/cancel-job.flow.js';
import {
  ContinueAsNewJobFlow,
  type ContinueAsNewJobInput,
} from './flows/continue-as-new-job.flow.js';
import { CreateJobFlow, type CreateManagedJobInput } from './flows/create-job.flow.js';
import { ResumeJobFlow } from './flows/resume-job.flow.js';
import { RetryJobFlow, type RetryManagedJobInput } from './flows/retry-job.flow.js';
import type { JobExecutorPort } from './job-executor.js';
import { JobAttemptStarter } from './shared/job-attempt-starter.js';
import { JobEventPublisher } from './shared/job-event-publisher.js';
import { JobExecutionDispatcher } from './shared/job-execution-dispatcher.js';
import {
  randomJobFlowIds,
  type JobFlowClock,
  type JobFlowIds,
} from './shared/job-flow.helper.js';

export interface JobManagerOptions {
  store: AgentStore;
  workerId: string;
  jobLeaseMs: number;
  publisher: RuntimeEventPublisher;
  execution: JobExecutorPort;
  clock?: JobFlowClock;
  ids?: JobFlowIds;
}

export interface JobManagerPort {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  createJob(input: CreateManagedJobInput): Promise<CreateJobAndAppendUserMessageResult>;
  cancelJob(jobId: string, expectedVersion: number): Promise<AgentJob>;
  retryJob(input: RetryManagedJobInput): Promise<CreateRetryJobResult>;
  continueAsNewJob(input: ContinueAsNewJobInput): Promise<CreateJobAndAppendUserMessageResult>;
  resumeJob(jobId: string, expectedVersion: number): Promise<AgentJob>;
  answerUserInputRequest(
    input: Omit<AnswerUserInputRequestInput, 'answerMessageId'>
  ): Promise<SaveUserInputAnswerResult>;
}

/** Public Job command facade. Each command delegates to an explicit orchestration Flow. */
export class JobManager implements JobManagerPort {
  readonly #create: CreateJobFlow;
  readonly #retry: RetryJobFlow;
  readonly #continueAsNew: ContinueAsNewJobFlow;
  readonly #resume: ResumeJobFlow;
  readonly #cancel: CancelJobFlow;
  readonly #answerUserInput: AnswerUserInputFlow;

  constructor(private readonly options: JobManagerOptions) {
    const clock = options.clock ?? { nowMs: () => Date.now() };
    const ids = options.ids ?? randomJobFlowIds;
    const events = new JobEventPublisher(options.publisher);
    const attempts = new JobAttemptStarter(
      options.store,
      options.workerId,
      options.jobLeaseMs,
      clock,
      ids.attemptId,
      events
    );
    const dispatcher = new JobExecutionDispatcher(options.execution);
    this.#create = new CreateJobFlow(
      options.store,
      clock,
      ids.jobId,
      ids.messageId,
      attempts,
      events,
      dispatcher
    );
    this.#retry = new RetryJobFlow(
      options.store,
      clock,
      ids.jobId,
      attempts,
      events,
      dispatcher
    );
    this.#continueAsNew = new ContinueAsNewJobFlow(
      options.store,
      clock,
      ids.jobId,
      ids.messageId,
      attempts,
      events,
      dispatcher
    );
    this.#resume = new ResumeJobFlow(
      options.store,
      options.workerId,
      clock,
      attempts,
      events,
      dispatcher
    );
    this.#cancel = new CancelJobFlow(options.store, clock, events, options.execution);
    this.#answerUserInput = new AnswerUserInputFlow(
      options.store,
      options.workerId,
      options.jobLeaseMs,
      clock,
      ids.messageId,
      ids.attemptId,
      events,
      dispatcher
    );
  }

  start(): Promise<void> {
    return this.options.execution.start();
  }

  shutdown(): Promise<void> {
    return this.options.execution.shutdown();
  }

  createJob(input: CreateManagedJobInput): Promise<CreateJobAndAppendUserMessageResult> {
    return this.#create.execute(input);
  }

  retryJob(input: RetryManagedJobInput): Promise<CreateRetryJobResult> {
    return this.#retry.execute(input);
  }

  continueAsNewJob(input: ContinueAsNewJobInput): Promise<CreateJobAndAppendUserMessageResult> {
    return this.#continueAsNew.execute(input);
  }

  resumeJob(jobId: string, expectedVersion: number): Promise<AgentJob> {
    return this.#resume.execute(jobId, expectedVersion);
  }

  cancelJob(jobId: string, expectedVersion: number): Promise<AgentJob> {
    return this.#cancel.execute(jobId, expectedVersion);
  }

  answerUserInputRequest(
    input: Omit<AnswerUserInputRequestInput, 'answerMessageId'>
  ): Promise<SaveUserInputAnswerResult> {
    return this.#answerUserInput.execute(input);
  }
}

export type {
  AnswerUserInputRequestInput,
  ContinueAsNewJobInput,
  CreateManagedJobInput,
  RetryManagedJobInput,
};
