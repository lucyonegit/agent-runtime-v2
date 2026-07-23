import { randomUUID } from 'node:crypto';
import type { AgentJob, AgentRealtimeEvent } from '../domain/index.js';
import {
  type AgentStore,
  type SaveUserInputAnswerResult,
  type CreateJobAndAppendUserMessageResult,
} from '../storage/agent-store.js';
import {
  resolveExecutionLimits,
  type ExecutionLimits,
} from '../runtime/settings/execution-limits.js';
import { RuntimeError } from '../runtime/errors/runtime-error.js';
import type { RuntimeEventPublisher } from '../runtime/events/runtime-event-writer.js';
import { projectSensitiveAnswers } from '../view/session-view.js';
import type { JobExecutionSupervisorPort } from './job-execution-supervisor.js';
import {
  cancelJobRecord,
  createJobRecord,
  createRetryJobRecord,
  failJobRecord,
  getJobRecord,
  resumeJobExecution,
  saveUserInputAnswer,
  startJobExecution,
  type JobPersistenceContext,
  type JobPersistenceIds,
  type RetryJobRecordResult,
  type SaveUserInputAnswerInput,
} from './helpers/job-persistence.helper.js';

export interface JobManagerClock {
  nowMs(): number;
}

export type JobManagerIds = JobPersistenceIds;

export interface JobManagerOptions {
  store: AgentStore;
  publisher: RuntimeEventPublisher;
  execution: JobExecutionSupervisorPort;
  workerId: string;
  limits?: Partial<ExecutionLimits>;
  clock?: JobManagerClock;
  ids?: JobManagerIds;
}

export type RetryJobResult = RetryJobRecordResult;
export type AnswerUserInputRequestInput = SaveUserInputAnswerInput;

export interface CreateManagedJobInput {
  sessionId: string;
  message: string;
  clientRequestId: string;
}

export interface RetryManagedJobInput {
  failedJobId: string;
  clientRequestId: string;
  message?: string;
}

export interface JobManagerPort {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  createJob(input: CreateManagedJobInput): Promise<CreateJobAndAppendUserMessageResult>;
  cancelJob(jobId: string, expectedVersion: number): Promise<AgentJob>;
  retryJob(input: RetryManagedJobInput): Promise<RetryJobResult>;
  resumeJob(jobId: string, expectedVersion: number): Promise<AgentJob>;
  answerUserInputRequest(
    input: Omit<AnswerUserInputRequestInput, 'answerMessageId'>
  ): Promise<SaveUserInputAnswerResult>;
}

export class JobManager implements JobManagerPort {
  readonly #store: AgentStore;
  readonly #publisher: RuntimeEventPublisher;
  readonly #execution: JobExecutionSupervisorPort;
  readonly #persistence: JobPersistenceContext;
  readonly #ids: JobManagerIds;

  constructor(options: JobManagerOptions) {
    if (!options.workerId.trim()) throw new TypeError('workerId must not be empty.');
    this.#store = options.store;
    this.#publisher = options.publisher;
    this.#execution = options.execution;
    const limits = resolveExecutionLimits(options.limits);
    this.#persistence = {
      store: options.store,
      workerId: options.workerId,
      jobLeaseMs: limits.jobLeaseMs,
      clock: options.clock ?? systemClock,
    };
    this.#ids = options.ids ?? randomIds;
  }

  start(): Promise<void> {
    return this.#execution.start();
  }

  shutdown(): Promise<void> {
    return this.#execution.shutdown();
  }

  async createJob(
    input: CreateManagedJobInput
  ): Promise<CreateJobAndAppendUserMessageResult> {
    const creationResult = await createJobRecord(this.#persistence, this.#ids, {
      sessionId: input.sessionId,
      content: input.message,
      clientRequestId: input.clientRequestId,
    });
    await this.#publishMany([
      { type: 'job.upserted', sessionId: input.sessionId, job: creationResult.job },
      { type: 'message.upserted', sessionId: input.sessionId, message: creationResult.message },
    ]);
    if (creationResult.job.status !== 'created') return creationResult;

    const runningJob = await startJobExecution(
      this.#persistence,
      this.#ids,
      creationResult.job.id,
      creationResult.job.version
    );
    await this.#publishMany([{
      type: 'job.upserted',
      sessionId: runningJob.sessionId,
      job: runningJob,
    }]);
    this.#startExecutionInBackground(runningJob.id);
    return { ...creationResult, job: runningJob };
  }

  async cancelJob(jobId: string, expectedVersion: number): Promise<AgentJob> {
    const job = await this.#cancelUsingLatestVersion(jobId, expectedVersion);
    // Persist the terminal state before aborting I/O so every subsequent write
    // is rejected by the Job fence, even if a driver ignores AbortSignal.
    this.#execution.abortExecution(job.id);
    await this.#publishMany([{ type: 'job.upserted', sessionId: job.sessionId, job }]);
    return job;
  }

  async retryJob(input: RetryManagedJobInput): Promise<RetryJobResult> {
    const retryResult = await createRetryJobRecord(this.#persistence, this.#ids, {
      failedJobId: input.failedJobId,
      clientRequestId: input.clientRequestId,
      content: input.message,
    });
    await this.#publishMany([
      { type: 'job.upserted', sessionId: retryResult.job.sessionId, job: retryResult.job },
      ...('message' in retryResult
        ? [{
            type: 'message.upserted' as const,
            sessionId: retryResult.job.sessionId,
            message: retryResult.message,
          }]
        : []),
    ]);
    const runningJob = await startJobExecution(
      this.#persistence,
      this.#ids,
      retryResult.job.id,
      retryResult.job.version
    );
    await this.#publishMany([{
      type: 'job.upserted',
      sessionId: runningJob.sessionId,
      job: runningJob,
    }]);
    this.#startExecutionInBackground(runningJob.id);
    return { ...retryResult, job: runningJob };
  }

  async resumeJob(jobId: string, expectedVersion: number): Promise<AgentJob> {
    const runningJob = await resumeJobExecution(
      this.#persistence,
      this.#ids,
      jobId,
      expectedVersion
    );
    await this.#publishMany([{
      type: 'job.upserted',
      sessionId: runningJob.sessionId,
      job: runningJob,
    }]);

    const prepared = await this.#store.prepareToolInvocationsForRecovery({
      jobId: runningJob.id,
      workerId: runningJob.leaseOwner!,
      attemptId: runningJob.currentAttemptId!,
      nowMs: this.#persistence.clock.nowMs(),
    });
    await this.#publishMany([
      ...prepared.invocations,
      ...prepared.blockedInvocations,
    ].map(invocation => ({
      type: 'tool_invocation.upserted' as const,
      sessionId: runningJob.sessionId,
      invocation,
    })));
    if (prepared.blockedInvocations.length > 0) {
      const failedJob = await failJobRecord(this.#persistence, runningJob, {
        code: 'unsafe_tool_recovery',
        message: 'A side-effecting tool was interrupted after it started. Its outcome must be reconciled before retrying.',
        details: prepared.blockedInvocations.map(invocation => ({
          invocationId: invocation.id,
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          status: invocation.status,
          sideEffectLevel: invocation.sideEffectLevel,
        })),
      });
      await this.#publishMany([{
        type: 'job.upserted',
        sessionId: failedJob.sessionId,
        job: failedJob,
      }]);
      return failedJob;
    }
    this.#startExecutionInBackground(runningJob.id);
    return runningJob;
  }

  async answerUserInputRequest(
    input: Omit<AnswerUserInputRequestInput, 'answerMessageId'>
  ): Promise<SaveUserInputAnswerResult> {
    const answerResult = await saveUserInputAnswer(this.#persistence, this.#ids, input);
    const publicAnswer = projectSensitiveAnswers(
      [answerResult.answerMessage],
      answerResult.invocation ? [answerResult.invocation] : [],
      [answerResult.request]
    );
    await this.#publishMany([
      {
        type: 'message.upserted',
        sessionId: answerResult.job.sessionId,
        message: publicAnswer.messages[0]!,
      },
      ...(publicAnswer.invocations[0] ? [{
        type: 'tool_invocation.upserted' as const,
        sessionId: answerResult.job.sessionId,
        invocation: publicAnswer.invocations[0],
      }] : []),
      {
        type: 'user_input.upserted',
        sessionId: answerResult.job.sessionId,
        request: publicAnswer.requests[0]!,
      },
      { type: 'job.upserted', sessionId: answerResult.job.sessionId, job: answerResult.job },
    ]);
    if (answerResult.shouldResume) {
      this.#startExecutionInBackground(answerResult.job.id);
    }
    return answerResult;
  }

  async #publishMany(events: AgentRealtimeEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.#publisher.publish(event);
      } catch {
        // Full SessionView recovery is authoritative after a publish failure.
      }
    }
  }

  async #cancelUsingLatestVersion(
    jobId: string,
    expectedVersion: number
  ): Promise<AgentJob> {
    try {
      return await cancelJobRecord(this.#persistence, jobId, expectedVersion);
    } catch (error) {
      if (!(error instanceof RuntimeError && error.code === 'concurrency_conflict')) throw error;
      const latest = await getJobRecord(this.#store, jobId);
      if (!latest) throw error;
      if (latest.status === 'cancelled') return latest;
      if (![
        'created',
        'running',
        'waiting_user_input',
        'resuming',
        'recovery_required',
      ].includes(latest.status)) {
        throw error;
      }
      return cancelJobRecord(this.#persistence, jobId, latest.version);
    }
  }

  #startExecutionInBackground(jobId: string): void {
    void this.#execution.startExecution(jobId).catch(() => {
      // The supervisor persists terminal failure while it still owns the Job.
    });
  }

}

const systemClock: JobManagerClock = {
  nowMs: () => Date.now(),
};

const randomIds: JobManagerIds = {
  jobId: () => `job_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  attemptId: () => `attempt_${randomUUID()}`,
};
