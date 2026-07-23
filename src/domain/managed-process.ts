export const AGENT_MANAGED_PROCESS_STATUSES = [
  'starting',
  'running',
  'stopping',
  'stopped',
  'exited',
  'failed',
  'unknown',
] as const;

export type AgentManagedProcessStatus = typeof AGENT_MANAGED_PROCESS_STATUSES[number];

export interface AgentManagedProcess {
  id: string;
  sessionId: string;
  jobId: string;
  toolInvocationId: string;
  name: string;
  command: string;
  cwd: string;
  status: AgentManagedProcessStatus;
  pid?: number;
  processGroupId?: number;
  host: string;
  port: number;
  url: string;
  logPath: string;
  exitCode?: number;
  exitSignal?: string;
  error?: { code: string; message: string; details?: unknown };
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  startedAtMs?: number;
  updatedAtMs: number;
  completedAtMs?: number;
}

