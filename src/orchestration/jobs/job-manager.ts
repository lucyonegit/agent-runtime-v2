import type { AgentJob } from '../../domain/index.js';
import type {
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
import { JobStore } from './shared/job-store.js';

export interface JobManagerOptions {
  jobStore: JobStore;
  publisher: RuntimeEventPublisher;
  execution: JobExecutorPort;
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
    const events = new JobEventPublisher(options.publisher);
    const attempts = new JobAttemptStarter(options.jobStore, events);
    const dispatcher = new JobExecutionDispatcher(options.execution);
    this.#create = new CreateJobFlow(options.jobStore, attempts, events, dispatcher);
    this.#retry = new RetryJobFlow(options.jobStore, attempts, events, dispatcher);
    this.#continueAsNew = new ContinueAsNewJobFlow(
      options.jobStore,
      attempts,
      events,
      dispatcher
    );
    this.#resume = new ResumeJobFlow(
      options.jobStore,
      attempts,
      events,
      dispatcher
    );
    this.#cancel = new CancelJobFlow(options.jobStore, events, options.execution);
    this.#answerUserInput = new AnswerUserInputFlow(options.jobStore, events, dispatcher);
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
