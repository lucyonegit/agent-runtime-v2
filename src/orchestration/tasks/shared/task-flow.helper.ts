import { randomUUID } from 'node:crypto';
import { isTerminalTaskStatus, type AgentTask } from '../../../domain/index.js';
import type {
  AgentStore,
  CreateRetryTaskResult,
  CreateTaskWithUserMessageResult,
} from '../../../storage/agent-store.js';
import { RuntimeError } from '../../../runtime/errors/runtime-error.js';

export interface TaskFlowClock {
  nowMs(): number;
}

export interface TaskFlowIds {
  taskId(): string;
  messageId(): string;
  taskRunId(): string;
}

export const randomTaskFlowIds: TaskFlowIds = {
  taskId: () => `task_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  taskRunId: () => `task_run_${randomUUID()}`,
};

/** Retry and Continue-as-new may only branch from an already finished Task. */
export async function loadTerminalTask(
  store: AgentStore,
  sourceTaskId: string
): Promise<AgentTask> {
  const source = await store.tasks.get(sourceTaskId);
  if (!source) {
    throw new RuntimeError(
      'invalid_task_state',
      `Source Task ${JSON.stringify(sourceTaskId)} was not found.`
    );
  }
  if (!isTerminalTaskStatus(source.status)) {
    throw new RuntimeError(
      'invalid_task_state',
      `Source Task ${JSON.stringify(source.id)} must be terminal, not ${source.status}.`
    );
  }
  return source;
}

/** Reconstructs the committed result of an idempotent create request. */
export async function resolveIdempotentTaskCreate(
  store: AgentStore,
  input: { sessionId: string; clientRequestId: string; content: string }
): Promise<CreateTaskWithUserMessageResult> {
  const [session, task, messages] = await Promise.all([
    store.sessions.get(input.sessionId),
    store.tasks.getByClientRequestId(input.sessionId, input.clientRequestId),
    store.sessions.listMessages(input.sessionId),
  ]);
  const message = task && messages.find(candidate => candidate.id === task.goalMessageId);
  if (!session || !task || !message) {
    throw new RuntimeError(
      'storage_error',
      'Idempotent Task replay could not load its committed entities.'
    );
  }
  if (message.content !== input.content || task.retryOfTaskId !== undefined) {
    throw new RuntimeError(
      'idempotency_conflict',
      `clientRequestId ${JSON.stringify(input.clientRequestId)} was reused with a different request.`,
      { details: { sessionId: input.sessionId, clientRequestId: input.clientRequestId } }
    );
  }
  return { session, task, message };
}

/** Reconstructs the committed result of an idempotent retry request. */
export async function resolveIdempotentTaskRetry(
  store: AgentStore,
  input: { source: AgentTask; clientRequestId: string }
): Promise<CreateRetryTaskResult> {
  const [session, task] = await Promise.all([
    store.sessions.get(input.source.sessionId),
    store.tasks.getByClientRequestId(input.source.sessionId, input.clientRequestId),
  ]);
  if (!session || !task) {
    throw new RuntimeError(
      'storage_error',
      'Idempotent Task retry replay could not load its committed entities.'
    );
  }
  if (task.retryOfTaskId !== input.source.id) {
    throw new RuntimeError(
      'idempotency_conflict',
      `clientRequestId ${JSON.stringify(input.clientRequestId)} was reused with a different request.`,
      {
        details: {
          sessionId: input.source.sessionId,
          clientRequestId: input.clientRequestId,
        },
      }
    );
  }
  return { session, task };
}
