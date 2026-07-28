/**
 * A replaceable cache used only to keep model input below its token limit.
 * Messages remain immutable; this row is not long-term memory.
 */
export interface AgentContextCompaction {
  sessionId: string;
  throughMessageRowId: number;
  summary: string;
  version: number;
  updatedAtMs: number;
}
