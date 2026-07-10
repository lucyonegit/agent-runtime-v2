import type { AgentJobError } from './job.js';

export const AGENT_STEP_RUN_STATUSES = [
  'created',
  'running',
  'waiting_user_input',
  'resuming',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AgentStepRunStatus = typeof AGENT_STEP_RUN_STATUSES[number];
export type AgentStepRunExecutor = 'agent' | 'code';

export const ACTIVE_STEP_RUN_STATUSES = [
  'created',
  'running',
  'waiting_user_input',
  'resuming',
] as const satisfies readonly AgentStepRunStatus[];

export interface AgentStepRun {
  id: string;
  sessionId: string;
  jobId: string;
  planId: string;
  stepId: string;
  runNo: number;
  executor: AgentStepRunExecutor;
  status: AgentStepRunStatus;
  currentAttemptId?: string;
  attemptNo: number;
  outputMessageId?: string;
  error?: AgentJobError;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
}
