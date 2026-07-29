import type { AgentExecutionError } from './execution-error.js';

export const AGENT_TOOL_CALL_STATUSES = [
  'pending',
  'running',
  'waiting_for_user',
  'completed',
  'failed',
  'outcome_unknown',
  'cancelled',
] as const;

export type AgentToolCallStatus = typeof AGENT_TOOL_CALL_STATUSES[number];
export type AgentToolSideEffectLevel = 'read_only' | 'idempotent' | 'side_effecting';

/** One model-emitted tool intent with at most one real execution attempt. */
export interface AgentToolCall {
  id: string;
  sessionId: string;
  taskId: string;
  createdInTaskRunId: string;
  callMessageId: string;
  resultMessageId?: string;
  modelToolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  argumentsChecksum: string;
  sideEffectLevel: AgentToolSideEffectLevel;
  idempotencyKey: string;
  status: AgentToolCallStatus;
  error?: AgentExecutionError;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs: number;
}
