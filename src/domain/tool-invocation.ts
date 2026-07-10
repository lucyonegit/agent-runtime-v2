import type { AgentJobError } from './job.js';

export const AGENT_TOOL_INVOCATION_STATUSES = [
  'pending',
  'running',
  'waiting_user_input',
  'completed',
  'failed',
  'unknown',
  'cancelled',
] as const;

export type AgentToolInvocationStatus = typeof AGENT_TOOL_INVOCATION_STATUSES[number];
export type AgentToolSideEffectLevel = 'read_only' | 'idempotent' | 'side_effecting';

export interface AgentToolInvocation {
  id: string;
  sessionId: string;
  jobId: string;
  planId?: string;
  stepId?: string;
  stepRunId?: string;
  attemptId: string;
  callMessageId: string;
  resultMessageId?: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  argumentsChecksum: string;
  sideEffectLevel: AgentToolSideEffectLevel;
  idempotencyKey: string;
  status: AgentToolInvocationStatus;
  resultPayload?: unknown;
  error?: AgentJobError;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs: number;
}
