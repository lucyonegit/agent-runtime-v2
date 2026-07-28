import { randomUUID } from 'node:crypto';
import {
  resolveJobGoalMessage,
  type AgentJob,
} from '../../../domain/index.js';
import type {
  AgentStore,
  CreateJobAndAppendUserMessageResult,
} from '../../../storage/agent-store.js';
import { RuntimeError } from '../../../runtime/errors/runtime-error.js';

export interface JobFlowClock {
  nowMs(): number;
}

export interface JobFlowIds {
  jobId(): string;
  messageId(): string;
  attemptId(): string;
}

export const randomJobFlowIds: JobFlowIds = {
  jobId: () => `job_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  attemptId: () => `attempt_${randomUUID()}`,
};

/** Loads and validates the immutable user goal reused by Retry. */
export async function loadRetrySource(
  store: AgentStore,
  failedJobId: string
): Promise<{ source: AgentJob; sourceGoalMessageId: string }> {
  const source = await store.jobs.get(failedJobId);
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

  const messages = await store.sessions.listMessages(source.sessionId);
  const goalMessage = resolveJobGoalMessage(source, messages);
  if (!goalMessage) {
    throw new RuntimeError(
      'storage_error',
      `Retry source Job ${JSON.stringify(source.id)} has no committed user message.`
    );
  }
  return { source, sourceGoalMessageId: goalMessage.id };
}

/** Reconstructs the already committed result of an idempotent create request. */
export async function resolveIdempotentJobCreate(
  store: AgentStore,
  input: {
    sessionId: string;
    clientRequestId: string;
    content: string;
  }
): Promise<CreateJobAndAppendUserMessageResult> {
  const [session, job, messages] = await Promise.all([
    store.sessions.get(input.sessionId),
    store.jobs.getByClientRequestId(input.sessionId, input.clientRequestId),
    store.sessions.listMessages(input.sessionId),
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
