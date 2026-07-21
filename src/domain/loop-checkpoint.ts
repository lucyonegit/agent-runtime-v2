export const AGENT_LOOP_CHECKPOINT_PHASES = [
  'ready_for_model',
  'tool_batch',
  'waiting_user_input',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AgentLoopCheckpointPhase = typeof AGENT_LOOP_CHECKPOINT_PHASES[number];

/**
 * A durable continuation point for one Job's ReAct loop. Checkpoints are
 * append-only: recovery never restores a JavaScript stack, it starts a new
 * loop from the latest persisted phase and counters.
 */
export interface AgentLoopCheckpoint {
  id: string;
  sessionId: string;
  jobId: string;
  attemptId: string;
  sequenceNo: number;
  phase: AgentLoopCheckpointPhase;
  callMessageId?: string;
  iterationNo: number;
  executedToolCalls: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
}
