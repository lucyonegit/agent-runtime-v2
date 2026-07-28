export const AGENT_TASK_CHECKPOINT_PHASES = [
  'ready_for_model',
  'tool_batch',
  'waiting_for_user',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AgentTaskCheckpointPhase = typeof AGENT_TASK_CHECKPOINT_PHASES[number];

/** Append-only ReAct continuation point written inside one TaskRun. */
export interface AgentTaskCheckpoint {
  id: string;
  sessionId: string;
  taskId: string;
  taskRunId: string;
  sequenceNo: number;
  phase: AgentTaskCheckpointPhase;
  callMessageId?: string;
  iterationNo: number;
  executedToolCalls: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
}
