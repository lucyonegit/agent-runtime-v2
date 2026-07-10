import { randomUUID } from 'node:crypto';
import type { AgentJob, AgentJobError } from '../domain/index.js';
import {
  AgentStoreError,
  type AgentStore,
  type AnswerInputAndClaimResumeResult,
  type CreateJobAndAppendUserMessageResult,
} from '../storage/agent-store.js';
import { resolveExecutionLimits, type ExecutionLimits } from './execution-limits.js';
import { RuntimeError, mapStoreError } from './runtime-errors.js';

export interface RuntimeClock {
  nowMs(): number;
}

export interface RuntimeIdGenerator {
  jobId(): string;
  messageId(): string;
  attemptId(): string;
}

export interface JobCoordinatorOptions {
  store: AgentStore;
  workerId: string;
  limits?: Partial<ExecutionLimits>;
  clock?: RuntimeClock;
  ids?: RuntimeIdGenerator;
}

export interface CreateCoordinatedJobInput {
  sessionId: string;
  content: string;
  projectId?: string;
  clientRequestId?: string;
  jobMetadata?: Record<string, unknown>;
  messageMetadata?: Record<string, unknown>;
  jobId?: string;
  userMessageId?: string;
}

export interface RetryCoordinatedJobInput {
  failedJobId: string;
  content?: string;
  clientRequestId?: string;
  jobId?: string;
  userMessageId?: string;
}

export interface AnswerCoordinatedInput {
  requestId: string;
  expectedVersion: number;
  clientAnswerId: string;
  answer: unknown;
  answerMessageId?: string;
}

export class JobCoordinator {
  readonly #store: AgentStore;
  readonly #workerId: string;
  readonly #limits: ExecutionLimits;
  readonly #clock: RuntimeClock;
  readonly #ids: RuntimeIdGenerator;

  constructor(options: JobCoordinatorOptions) {
    if (!options.workerId.trim()) throw new TypeError('workerId must not be empty.');
    this.#store = options.store;
    this.#workerId = options.workerId;
    this.#limits = resolveExecutionLimits(options.limits);
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? randomIds;
  }

  async createJob(input: CreateCoordinatedJobInput): Promise<CreateJobAndAppendUserMessageResult> {
    const nowMs = this.#clock.nowMs();
    try {
      return await this.#store.createJobAndAppendUserMessage({
        sessionId: input.sessionId,
        jobId: input.jobId ?? this.#ids.jobId(),
        userMessageId: input.userMessageId ?? this.#ids.messageId(),
        content: input.content,
        projectId: input.projectId,
        clientRequestId: input.clientRequestId,
        jobMetadata: input.jobMetadata,
        messageMetadata: input.messageMetadata,
        nowMs,
      });
    } catch (error) {
      if (
        error instanceof AgentStoreError
        && error.code === 'CLIENT_REQUEST_CONFLICT'
        && input.clientRequestId
      ) {
        return this.#resolveIdempotentCreate(input);
      }
      throw mapStoreError(error);
    }
  }

  async claimJob(jobId: string, expectedVersion: number): Promise<AgentJob> {
    const nowMs = this.#clock.nowMs();
    try {
      return await this.#store.claimJob({
        jobId,
        expectedVersion,
        workerId: this.#workerId,
        attemptId: this.#ids.attemptId(),
        nowMs,
        leaseUntilMs: nowMs + this.#limits.jobLeaseMs,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async renewJobLease(job: AgentJob): Promise<AgentJob> {
    if (!job.currentAttemptId || job.leaseOwner !== this.#workerId) {
      throw new RuntimeError(
        'lease_lost',
        `Job ${JSON.stringify(job.id)} is not owned by this coordinator.`,
        { details: { jobId: job.id, workerId: this.#workerId } }
      );
    }
    const nowMs = this.#clock.nowMs();
    try {
      return await this.#store.renewJobLease({
        jobId: job.id,
        expectedVersion: job.version,
        workerId: this.#workerId,
        attemptId: job.currentAttemptId,
        nowMs,
        leaseUntilMs: nowMs + this.#limits.jobLeaseMs,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async failJob(job: AgentJob, error: AgentJobError): Promise<AgentJob> {
    if (!job.currentAttemptId) {
      throw new RuntimeError('lease_lost', `Job ${JSON.stringify(job.id)} has no active attempt.`);
    }
    try {
      return await this.#store.failJob({
        jobId: job.id,
        expectedVersion: job.version,
        workerId: this.#workerId,
        attemptId: job.currentAttemptId,
        error,
        nowMs: this.#clock.nowMs(),
      });
    } catch (storeError) {
      throw mapStoreError(storeError);
    }
  }

  async cancelJob(jobId: string, expectedVersion: number): Promise<AgentJob> {
    try {
      return await this.#store.cancelJob({
        jobId,
        expectedVersion,
        nowMs: this.#clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async retryJob(input: RetryCoordinatedJobInput): Promise<CreateJobAndAppendUserMessageResult> {
    const source = await this.#store.getJob(input.failedJobId);
    if (!source) {
      throw new RuntimeError(
        'invalid_job_state',
        `Retry source Job ${JSON.stringify(input.failedJobId)} was not found.`
      );
    }
    if (source.status !== 'failed') {
      throw new RuntimeError(
        'invalid_job_state',
        `Retry source Job ${JSON.stringify(source.id)} must be failed, not ${source.status}.`
      );
    }
    const sourceMessages = await this.#store.listSessionMessages(source.sessionId);
    const sourceUserMessage = sourceMessages.find(message => (
      message.jobId === source.id && message.messageType === 'user_message'
    ));
    const content = input.content ?? sourceUserMessage?.content;
    if (content === undefined) {
      throw new RuntimeError(
        'storage_error',
        `Retry source Job ${JSON.stringify(source.id)} has no committed user message.`
      );
    }

    try {
      return await this.#store.createJobAndAppendUserMessage({
        sessionId: source.sessionId,
        jobId: input.jobId ?? this.#ids.jobId(),
        userMessageId: input.userMessageId ?? this.#ids.messageId(),
        content,
        projectId: source.projectId,
        retryOfJobId: source.id,
        clientRequestId: input.clientRequestId,
        jobMetadata: source.metadata,
        nowMs: this.#clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async answerInput(input: AnswerCoordinatedInput): Promise<AnswerInputAndClaimResumeResult> {
    const nowMs = this.#clock.nowMs();
    try {
      return await this.#store.answerInputAndClaimResume({
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        clientAnswerId: input.clientAnswerId,
        answer: input.answer,
        answerMessageId: input.answerMessageId ?? this.#ids.messageId(),
        workerId: this.#workerId,
        attemptId: this.#ids.attemptId(),
        nowMs,
        leaseUntilMs: nowMs + this.#limits.jobLeaseMs,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #resolveIdempotentCreate(
    input: CreateCoordinatedJobInput
  ): Promise<CreateJobAndAppendUserMessageResult> {
    const [session, job, messages] = await Promise.all([
      this.#store.getSession(input.sessionId),
      this.#store.getJobByClientRequestId(input.sessionId, input.clientRequestId!),
      this.#store.listSessionMessages(input.sessionId),
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
    if (
      message.content !== input.content
      || job.projectId !== input.projectId
      || job.retryOfJobId !== undefined
    ) {
      throw new RuntimeError(
        'idempotency_conflict',
        `clientRequestId ${JSON.stringify(input.clientRequestId)} was reused with a different request.`,
        { details: { sessionId: input.sessionId, clientRequestId: input.clientRequestId } }
      );
    }
    return { session, job, message };
  }
}

const systemClock: RuntimeClock = {
  nowMs: () => Date.now(),
};

const randomIds: RuntimeIdGenerator = {
  jobId: () => `job_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  attemptId: () => `attempt_${randomUUID()}`,
};
