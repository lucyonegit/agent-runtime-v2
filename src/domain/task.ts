import type { AgentMessage } from './message.js';
import type { AgentExecutionError } from './execution-error.js';

export const AGENT_TASK_STATUSES = [
  'created',
  'running',
  'waiting_for_user',
  'recovery_required',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AgentTaskStatus = typeof AGENT_TASK_STATUSES[number];

export const ACTIVE_TASK_STATUSES = [
  'created',
  'running',
  'waiting_for_user',
  'recovery_required',
] as const satisfies readonly AgentTaskStatus[];

const TERMINAL_TASK_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly AgentTaskStatus[];

/** One durable user goal. Physical execution windows live in AgentTaskRun. */
export interface AgentTask {
  id: string;
  sessionId: string;
  goalMessageId: string;
  clientRequestId?: string;
  status: AgentTaskStatus;
  error?: AgentExecutionError;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
}

export function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status as typeof TERMINAL_TASK_STATUSES[number]);
}

export function resolveTaskGoalMessage(
  task: Pick<AgentTask, 'goalMessageId'>,
  messages: AgentMessage[]
): AgentMessage | undefined {
  return messages.find(message => (
    message.id === task.goalMessageId
    && message.role === 'user'
    && message.messageType === 'user_message'
  ));
}
