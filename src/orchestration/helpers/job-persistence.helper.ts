import type { AgentJob, AgentJobError } from '../../domain/index.js';
import {
  AgentStoreError,
  type AgentStore,
  type CreateJobAndAppendUserMessageResult,
  type CreateRetryJobResult,
  type SaveUserInputAnswerResult,
} from '../../storage/agent-store.js';
import { resolveJobGoalMessage, withGoalMessageId } from '../../runtime/job-goal.js';
import { RuntimeError, mapStoreError } from '../../runtime/runtime-errors.js';

export interface JobPersistenceContext {
  store: AgentStore;
  workerId: string;
  jobLeaseMs: number;
  clock: { nowMs(): number };
}

export interface JobPersistenceIds {
  jobId(): string;
  messageId(): string;
  attemptId(): string;
}

export interface CreateJobRecordInput {
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
  content?: string;
  clientRequestId?: string;
  jobId?: string;
  userMessageId?: string;
}

export interface SaveUserInputAnswerInput {
  requestId: string;
  expectedVersion: number;
  clientAnswerId: string;
  answer: unknown;
  answerMessageId?: string;
}

export type RetryJobRecordResult =
  | CreateJobAndAppendUserMessageResult
  | CreateRetryJobResult;

export async function createJobRecord(
  context: JobPersistenceContext,
  ids: JobPersistenceIds,
  input: CreateJobRecordInput
): Promise<CreateJobAndAppendUserMessageResult> {
  const nowMs = context.clock.nowMs();
  const jobId = input.jobId ?? ids.jobId();
  const userMessageId = input.userMessageId ?? ids.messageId();
  try {
    return await context.store.createJobAndAppendUserMessage({
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
      return resolveIdempotentCreate(context.store, input);
    }
    throw mapStoreError(error);
  }
}

export async function startJobExecution(
  context: JobPersistenceContext,
  ids: JobPersistenceIds,
  jobId: string,
  expectedVersion: number
): Promise<AgentJob> {
  const nowMs = context.clock.nowMs();
  try {
    return await context.store.startJobExecution({
      jobId,
      expectedVersion,
      workerId: context.workerId,
      attemptId: ids.attemptId(),
      nowMs,
      leaseUntilMs: nowMs + context.jobLeaseMs,
    });
  } catch (error) {
    throw mapStoreError(error);
  }
}

export async function resumeJobExecution(
  context: JobPersistenceContext,
  ids: JobPersistenceIds,
  jobId: string,
  expectedVersion: number
): Promise<AgentJob> {
  const job = await getJobRecord(context.store, jobId);
  if (!job || job.status !== 'recovery_required') {
    throw new RuntimeError(
      'invalid_job_state',
      `Job ${JSON.stringify(jobId)} must require recovery before it can be resumed.`,
      { details: { jobId, status: job?.status } }
    );
  }
  return startJobExecution(context, ids, jobId, expectedVersion);
}

export async function getJobRecord(
  store: AgentStore,
  jobId: string
): Promise<AgentJob | undefined> {
  try {
    return await store.getJob(jobId);
  } catch (error) {
    throw mapStoreError(error);
  }
}

export async function renewJobExecutionOwnership(
  context: JobPersistenceContext,
  job: AgentJob
): Promise<AgentJob> {
  if (!job.currentAttemptId || job.leaseOwner !== context.workerId) {
    throw new RuntimeError(
      'lease_lost',
      `Job ${JSON.stringify(job.id)} is not owned by this execution supervisor.`,
      { details: { jobId: job.id, workerId: context.workerId } }
    );
  }
  const nowMs = context.clock.nowMs();
  try {
    return await context.store.renewJobExecutionLease({
      jobId: job.id,
      expectedVersion: job.version,
      workerId: context.workerId,
      attemptId: job.currentAttemptId,
      nowMs,
      leaseUntilMs: nowMs + context.jobLeaseMs,
    });
  } catch (error) {
    throw mapStoreError(error);
  }
}

export async function markJobRecoveryRequired(
  context: JobPersistenceContext,
  jobId: string,
  expectedVersion: number
): Promise<AgentJob> {
  try {
    return await context.store.markJobRecoveryRequired({
      jobId,
      expectedVersion,
      nowMs: context.clock.nowMs(),
    });
  } catch (error) {
    throw mapStoreError(error);
  }
}

export async function failJobRecord(
  context: JobPersistenceContext,
  job: AgentJob,
  error: AgentJobError
): Promise<AgentJob> {
  if (!job.currentAttemptId) {
    throw new RuntimeError('lease_lost', `Job ${JSON.stringify(job.id)} has no active attempt.`);
  }
  try {
    return await context.store.failJob({
      jobId: job.id,
      expectedVersion: job.version,
      workerId: context.workerId,
      attemptId: job.currentAttemptId,
      error,
      nowMs: context.clock.nowMs(),
    });
  } catch (storeError) {
    throw mapStoreError(storeError);
  }
}

export async function cancelJobRecord(
  context: JobPersistenceContext,
  jobId: string,
  expectedVersion: number
): Promise<AgentJob> {
  try {
    return await context.store.cancelJob({
      jobId,
      expectedVersion,
      nowMs: context.clock.nowMs(),
    });
  } catch (error) {
    throw mapStoreError(error);
  }
}

export async function createRetryJobRecord(
  context: JobPersistenceContext,
  ids: JobPersistenceIds,
  input: CreateRetryJobInput
): Promise<RetryJobRecordResult> {
  const source = await context.store.getJob(input.failedJobId);
  if (!source) {
    throw new RuntimeError(
      'invalid_job_state',
      `Retry source Job ${JSON.stringify(input.failedJobId)} was not found.`
    );
  }
  if (!['failed', 'cancelled'].includes(source.status)) {
    throw new RuntimeError(
      'invalid_job_state',
      `Retry source Job ${JSON.stringify(source.id)} must be failed or cancelled, not ${source.status}.`
    );
  }
  const sourceMessages = await context.store.listSessionMessages(source.sessionId);
  const sourceGoalMessage = resolveJobGoalMessage(source, sourceMessages);
  if (!sourceGoalMessage) {
    throw new RuntimeError(
      'storage_error',
      `Retry source Job ${JSON.stringify(source.id)} has no committed user message.`
    );
  }
  const jobId = input.jobId ?? ids.jobId();
  const nowMs = context.clock.nowMs();

  try {
    if (input.content === undefined) {
      return await context.store.createRetryJob({
        sessionId: source.sessionId,
        jobId,
        retryOfJobId: source.id,
        clientRequestId: input.clientRequestId,
        jobMetadata: withGoalMessageId(source.metadata, sourceGoalMessage.id),
        nowMs,
      });
    }
    const userMessageId = input.userMessageId ?? ids.messageId();
    return await context.store.createJobAndAppendUserMessage({
      sessionId: source.sessionId,
      jobId,
      userMessageId,
      content: input.content,
      retryOfJobId: source.id,
      clientRequestId: input.clientRequestId,
      jobMetadata: withGoalMessageId(source.metadata, userMessageId),
      nowMs,
    });
  } catch (error) {
    throw mapStoreError(error);
  }
}

export async function saveUserInputAnswer(
  context: JobPersistenceContext,
  ids: JobPersistenceIds,
  input: SaveUserInputAnswerInput
): Promise<SaveUserInputAnswerResult> {
  const nowMs = context.clock.nowMs();
  try {
    return await context.store.saveUserInputAnswerAndResumeIfReady({
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      clientAnswerId: input.clientAnswerId,
      answer: input.answer,
      answerMessageId: input.answerMessageId ?? ids.messageId(),
      workerId: context.workerId,
      attemptId: ids.attemptId(),
      nowMs,
      leaseUntilMs: nowMs + context.jobLeaseMs,
    });
  } catch (error) {
    throw mapStoreError(error);
  }
}

async function resolveIdempotentCreate(
  store: AgentStore,
  input: CreateJobRecordInput
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
  if (
    message.content !== input.content
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
