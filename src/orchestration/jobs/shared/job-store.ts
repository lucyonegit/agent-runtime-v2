import {
  resolveJobGoalMessage,
  withGoalMessageId,
  type AgentJob,
  type AgentJobError,
} from '../../../domain/index.js';
import {
  AgentStoreError,
  type AgentStore,
  type CreateJobAndAppendUserMessageResult,
  type CreateRetryJobResult,
  type PrepareToolInvocationsForRecoveryResult,
  type SaveUserInputAnswerResult,
} from '../../../storage/agent-store.js';
import { RuntimeError, mapStoreError } from '../../../runtime/errors/runtime-error.js';

export interface JobStoreClock {
  nowMs(): number;
}

export interface JobStoreIds {
  jobId(): string;
  messageId(): string;
  attemptId(): string;
}

export interface JobStoreOptions {
  store: AgentStore;
  workerId: string;
  jobLeaseMs: number;
  clock: JobStoreClock;
  ids?: JobStoreIds;
}

export interface CreateJobInput {
  sessionId: string;
  content: string;
  clientRequestId?: string;
  jobMetadata?: Record<string, unknown>;
  messageMetadata?: Record<string, unknown>;
  jobId?: string;
  userMessageId?: string;
}

export interface CreateRetryJobInput {
  failedJobId: string;
  clientRequestId?: string;
  jobId?: string;
}

export interface CreateContinuationJobInput extends CreateRetryJobInput {
  content: string;
  userMessageId?: string;
}

export interface SaveUserInputAnswerInput {
  requestId: string;
  expectedVersion: number;
  clientAnswerId: string;
  answer: unknown;
  answerMessageId?: string;
}

/**
 * Job-specific storage gateway for durable commands.
 *
 * This class makes database-backed AgentStore operations explicit at call
 * sites. It owns persistence preconditions, generated IDs and store-error
 * mapping. Business sequencing, realtime publication and background dispatch
 * deliberately stay in the owning orchestration Flow.
 */
export class JobStore {
  readonly #ids: JobStoreIds;

  constructor(private readonly options: JobStoreOptions) {
    this.#ids = options.ids ?? randomIds;
  }

  async createJobWithMessage(input: CreateJobInput): Promise<CreateJobAndAppendUserMessageResult> {
    const nowMs = this.options.clock.nowMs();
    const jobId = input.jobId ?? this.#ids.jobId();
    const userMessageId = input.userMessageId ?? this.#ids.messageId();
    try {
      return await this.options.store.createJobAndAppendUserMessage({
        sessionId: input.sessionId,
        jobId,
        userMessageId,
        content: input.content,
        clientRequestId: input.clientRequestId,
        jobMetadata: withGoalMessageId(input.jobMetadata, userMessageId),
        messageMetadata: input.messageMetadata,
        nowMs,
      });
    } catch (error) {
      if (
        error instanceof AgentStoreError
        && error.code === 'CLIENT_REQUEST_CONFLICT'
        && input.clientRequestId
      ) {
        return resolveIdempotentCreate(this.options.store, input);
      }
      throw mapStoreError(error);
    }
  }

  async createRetryFromOriginalGoal(input: CreateRetryJobInput): Promise<CreateRetryJobResult> {
    const { source, sourceGoalMessageId } = await this.#loadRetrySource(input.failedJobId);
    try {
      return await this.options.store.createRetryJob({
        sessionId: source.sessionId,
        jobId: input.jobId ?? this.#ids.jobId(),
        retryOfJobId: source.id,
        clientRequestId: input.clientRequestId,
        jobMetadata: withGoalMessageId(source.metadata, sourceGoalMessageId),
        nowMs: this.options.clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async createContinuationWithMessage(
    input: CreateContinuationJobInput
  ): Promise<CreateJobAndAppendUserMessageResult> {
    const { source } = await this.#loadRetrySource(input.failedJobId);
    const userMessageId = input.userMessageId ?? this.#ids.messageId();
    try {
      return await this.options.store.createJobAndAppendUserMessage({
        sessionId: source.sessionId,
        jobId: input.jobId ?? this.#ids.jobId(),
        userMessageId,
        content: input.content,
        retryOfJobId: source.id,
        clientRequestId: input.clientRequestId,
        jobMetadata: withGoalMessageId(source.metadata, userMessageId),
        nowMs: this.options.clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async startAttempt(job: AgentJob): Promise<AgentJob> {
    const nowMs = this.options.clock.nowMs();
    try {
      return await this.options.store.startJobExecution({
        jobId: job.id,
        expectedVersion: job.version,
        workerId: this.options.workerId,
        attemptId: this.#ids.attemptId(),
        nowMs,
        leaseUntilMs: nowMs + this.options.jobLeaseMs,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async requireRecoveryJob(jobId: string, expectedVersion: number): Promise<AgentJob> {
    const job = await this.getJob(jobId);
    if (!job || job.status !== 'recovery_required' || job.version !== expectedVersion) {
      throw new RuntimeError(
        'invalid_job_state',
        `Job ${JSON.stringify(jobId)} must require recovery at version ${expectedVersion}.`,
        { details: { jobId, expectedVersion, version: job?.version, status: job?.status } }
      );
    }
    return job;
  }

  async prepareToolInvocationsForRecovery(
    job: AgentJob
  ): Promise<PrepareToolInvocationsForRecoveryResult> {
    if (!job.currentAttemptId || job.leaseOwner !== this.options.workerId) {
      throw new RuntimeError(
        'lease_lost',
        `Job ${JSON.stringify(job.id)} is not owned by this Job executor.`,
        { details: { jobId: job.id, workerId: this.options.workerId } }
      );
    }
    try {
      return await this.options.store.prepareToolInvocationsForRecovery({
        jobId: job.id,
        workerId: this.options.workerId,
        attemptId: job.currentAttemptId,
        nowMs: this.options.clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async getJob(jobId: string): Promise<AgentJob | undefined> {
    try {
      return await this.options.store.getJob(jobId);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async renewExecutionOwnership(job: AgentJob): Promise<AgentJob> {
    if (!job.currentAttemptId || job.leaseOwner !== this.options.workerId) {
      throw new RuntimeError(
        'lease_lost',
        `Job ${JSON.stringify(job.id)} is not owned by this Job executor.`,
        { details: { jobId: job.id, workerId: this.options.workerId } }
      );
    }
    const nowMs = this.options.clock.nowMs();
    try {
      return await this.options.store.renewJobExecutionLease({
        jobId: job.id,
        expectedVersion: job.version,
        workerId: this.options.workerId,
        attemptId: job.currentAttemptId,
        nowMs,
        leaseUntilMs: nowMs + this.options.jobLeaseMs,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async markRecoveryRequired(jobId: string, expectedVersion: number): Promise<AgentJob> {
    try {
      return await this.options.store.markJobRecoveryRequired({
        jobId,
        expectedVersion,
        nowMs: this.options.clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async fail(job: AgentJob, error: AgentJobError): Promise<AgentJob> {
    if (!job.currentAttemptId) {
      throw new RuntimeError('lease_lost', `Job ${JSON.stringify(job.id)} has no active attempt.`);
    }
    try {
      return await this.options.store.failJob({
        jobId: job.id,
        expectedVersion: job.version,
        workerId: this.options.workerId,
        attemptId: job.currentAttemptId,
        error,
        nowMs: this.options.clock.nowMs(),
      });
    } catch (storeError) {
      throw mapStoreError(storeError);
    }
  }

  async cancel(jobId: string, expectedVersion: number): Promise<AgentJob> {
    try {
      return await this.options.store.cancelJob({
        jobId,
        expectedVersion,
        nowMs: this.options.clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async answerUserInput(input: SaveUserInputAnswerInput): Promise<SaveUserInputAnswerResult> {
    const nowMs = this.options.clock.nowMs();
    try {
      return await this.options.store.saveUserInputAnswerAndResumeIfReady({
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        clientAnswerId: input.clientAnswerId,
        answer: input.answer,
        answerMessageId: input.answerMessageId ?? this.#ids.messageId(),
        workerId: this.options.workerId,
        attemptId: this.#ids.attemptId(),
        nowMs,
        leaseUntilMs: nowMs + this.options.jobLeaseMs,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #loadRetrySource(failedJobId: string): Promise<{
    source: AgentJob;
    sourceGoalMessageId: string;
  }> {
    const source = await this.getJob(failedJobId);
    if (!source) {
      throw new RuntimeError(
        'invalid_job_state',
        `Retry source Job ${JSON.stringify(failedJobId)} was not found.`
      );
    }
    if (!['failed', 'cancelled'].includes(source.status)) {
      throw new RuntimeError(
        'invalid_job_state',
        `Retry source Job ${JSON.stringify(source.id)} must be failed or cancelled, not ${source.status}.`
      );
    }
    const sourceMessages = await this.options.store.listSessionMessages(source.sessionId);
    const sourceGoalMessage = resolveJobGoalMessage(source, sourceMessages);
    if (!sourceGoalMessage) {
      throw new RuntimeError(
        'storage_error',
        `Retry source Job ${JSON.stringify(source.id)} has no committed user message.`
      );
    }
    return { source, sourceGoalMessageId: sourceGoalMessage.id };
  }
}

const randomIds: JobStoreIds = {
  jobId: () => `job_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  attemptId: () => `attempt_${randomUUID()}`,
};

async function resolveIdempotentCreate(
  store: AgentStore,
  input: CreateJobInput
): Promise<CreateJobAndAppendUserMessageResult> {
  const [session, job, messages] = await Promise.all([
    store.getSession(input.sessionId),
    store.getJobByClientRequestId(input.sessionId, input.clientRequestId!),
    store.listSessionMessages(input.sessionId),
  ]);
  const message = job && messages.find(candidate => (
    candidate.jobId === job.id && candidate.messageType === 'user_message'
  ));
  if (!session || !job || !message) {
    throw new RuntimeError(
      'storage_error',
      'Idempotent Job replay could not load its committed entities.'
    );
  }
  if (message.content !== input.content || job.retryOfJobId !== undefined) {
    throw new RuntimeError(
      'idempotency_conflict',
      `clientRequestId ${JSON.stringify(input.clientRequestId)} was reused with a different request.`,
      { details: { sessionId: input.sessionId, clientRequestId: input.clientRequestId } }
    );
  }
  return { session, job, message };
}
import { randomUUID } from 'node:crypto';
