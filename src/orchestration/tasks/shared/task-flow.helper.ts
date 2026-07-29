import { randomUUID } from 'node:crypto';
import type { AgentStore, CreateTaskWithUserMessageResult } from '../../../storage/agent-store.js';
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
