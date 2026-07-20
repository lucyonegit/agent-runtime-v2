export const AGENT_JOB_STATUSES = [
  'created',
  'running',
  'waiting_user_input',
  'resuming',
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
] as const satisfies readonly AgentJobStatus[];

export const TERMINAL_JOB_STATUSES = [
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

const JOB_TRANSITIONS: Record<AgentJobStatus, readonly AgentJobStatus[]> = {
  created: ['running', 'cancelled'],
  running: ['waiting_user_input', 'completed', 'failed', 'cancelled'],
  waiting_user_input: ['resuming', 'cancelled'],
  resuming: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalJobStatus(status: AgentJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status as typeof TERMINAL_JOB_STATUSES[number]);
}

export function canTransitionJob(from: AgentJobStatus, to: AgentJobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}
