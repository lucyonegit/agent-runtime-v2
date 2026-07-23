const AGENT_JOB_STATUSES = [
  'created',
  'running',
  'waiting_user_input',
  'resuming',
  'recovery_required',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AgentJobStatus = typeof AGENT_JOB_STATUSES[number];

export const ACTIVE_JOB_STATUSES = [
  'created',
  'running',
  'waiting_user_input',
  'resuming',
  'recovery_required',
] as const satisfies readonly AgentJobStatus[];

const TERMINAL_JOB_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly AgentJobStatus[];

export interface AgentJobError {
  code: string;
  message: string;
  details?: unknown;
}

export interface AgentJob {
  id: string;
  sessionId: string;
  retryOfJobId?: string;
  clientRequestId?: string;
  status: AgentJobStatus;
  currentAttemptId?: string;
  attemptNo: number;
  leaseOwner?: string;
  leaseExpiresAtMs?: number;
  error?: AgentJobError;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
}

export function isTerminalJobStatus(status: AgentJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status as typeof TERMINAL_JOB_STATUSES[number]);
}
