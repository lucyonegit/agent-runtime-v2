import type { AgentExecutionError } from './execution-error.js';

export const AGENT_TASK_RUN_TRIGGERS = [
  'initial',
  'user_input_answered',
  'input_expired',
] as const;

export type AgentTaskRunTrigger = typeof AGENT_TASK_RUN_TRIGGERS[number];

export const AGENT_TASK_RUN_STATUSES = [
  'running',
  'paused',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
] as const;

export type AgentTaskRunStatus = typeof AGENT_TASK_RUN_STATUSES[number];

/** One physical ownership window for a Task. Every resume creates a new row. */
export interface AgentTaskRun {
  id: string;
  taskId: string;
  runNo: number;
  trigger: AgentTaskRunTrigger;
  status: AgentTaskRunStatus;
  ownerId?: string;
  ownershipExpiresAtMs?: number;
  error?: AgentExecutionError;
  metadata?: Record<string, unknown>;
  startedAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number;
}
