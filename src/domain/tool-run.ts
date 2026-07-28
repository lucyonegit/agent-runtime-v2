import type { AgentExecutionError } from './execution-error.js';

export const AGENT_TOOL_RUN_STATUSES = [
  'running',
  'completed',
  'failed',
  'interrupted',
  'outcome_unknown',
  'cancelled',
] as const;

export type AgentToolRunStatus = typeof AGENT_TOOL_RUN_STATUSES[number];

/** One physical execution of a logical ToolCall. */
export interface AgentToolRun {
  id: string;
  toolCallId: string;
  taskId: string;
  taskRunId: string;
  runNo: number;
  workerId: string;
  status: AgentToolRunStatus;
  error?: AgentExecutionError;
  startedAtMs: number;
  endedAtMs?: number;
  durationMs?: number;
}
