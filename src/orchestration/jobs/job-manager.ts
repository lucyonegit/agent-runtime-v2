import { randomUUID } from 'node:crypto';
import type { AgentJob } from '../../domain/index.js';
import type {
  AgentStore,
  CreateJobAndAppendUserMessageResult,
  CreateRetryJobResult,
  SaveUserInputAnswerResult,
} from '../../storage/agent-store.js';
import {
  resolveExecutionLimits,
  type ExecutionLimits,
} from '../../runtime/settings/execution-limits.js';
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
import type { JobExecutionSupervisorPort } from './job-execution-supervisor.js';
import { JobAttemptStarter } from './shared/job-attempt-starter.js';
import { JobEventPublisher } from './shared/job-event-publisher.js';
import { JobExecutionDispatcher } from './shared/job-execution-dispatcher.js';
import {
  JobStateTransitions,
  type JobStateClock,
  type JobStateIds,
} from './shared/job-state-transitions.js';

export interface JobManagerOptions {
  store: AgentStore;
  publisher: RuntimeEventPublisher;
  execution: JobExecutionSupervisorPort;
  workerId: string;
  limits?: Partial<ExecutionLimits>;
  clock?: JobStateClock;
  ids?: JobStateIds;
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
    if (!options.workerId.trim()) throw new TypeError('workerId must not be empty.');
    const limits = resolveExecutionLimits(options.limits);
    const clock = options.clock ?? systemClock;
    const state = new JobStateTransitions({
      store: options.store,
      workerId: options.workerId,
      jobLeaseMs: limits.jobLeaseMs,
      clock,
      ids: options.ids ?? randomIds,
    });
    const events = new JobEventPublisher(options.publisher);
    const attempts = new JobAttemptStarter(state, events);
    const dispatcher = new JobExecutionDispatcher(options.execution);
    this.#create = new CreateJobFlow(state, attempts, events, dispatcher);
    this.#retry = new RetryJobFlow(state, attempts, events, dispatcher);
    this.#continueAsNew = new ContinueAsNewJobFlow(
      state,
      attempts,
      events,
      dispatcher
    );
    this.#resume = new ResumeJobFlow(
      options.store,
      state,
      attempts,
      events,
      dispatcher,
      clock
    );
    this.#cancel = new CancelJobFlow(state, events, options.execution);
    this.#answerUserInput = new AnswerUserInputFlow(state, events, dispatcher);
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

const systemClock: JobStateClock = {
  nowMs: () => Date.now(),
};

const randomIds: JobStateIds = {
  jobId: () => `job_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  attemptId: () => `attempt_${randomUUID()}`,
};

export type {
  AnswerUserInputRequestInput,
  ContinueAsNewJobInput,
  CreateManagedJobInput,
  RetryManagedJobInput,
};
