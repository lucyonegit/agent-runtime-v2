import type {
  AgentActivePlan,
  AgentArtifact,
  AgentManagedProcess,
  AgentMessage,
  AgentModelUsageStats,
  AgentSession,
  AgentTask,
  AgentTaskRun,
  AgentToolCall,
  AgentUserInputRequest,
} from '../domain/index.js';

export const AGENT_SESSION_VIEW_SCHEMA_VERSION = 6 as const;

export type FlatTimelineItem =
  | { type: 'message'; rowId: number; message: AgentMessage }
  | {
      type: 'tool_exchange';
      rowId: number;
      callMessage: AgentMessage;
      toolCalls: AgentToolCall[];
      resultMessages: AgentMessage[];
      artifacts: AgentArtifact[];
      status: AgentToolCall['status'];
      warning?: string;
    };

/** Refresh-authoritative projection. ActivePlan is intentionally outside the timeline. */
export interface AgentSessionView {
  schemaVersion: typeof AGENT_SESSION_VIEW_SCHEMA_VERSION;
  generatedAtMs: number;
  session: AgentSession;
  tasks: AgentTask[];
  activeTask?: AgentTask;
  taskRuns: AgentTaskRun[];
  activePlan?: AgentActivePlan;
  messages: AgentMessage[];
  toolCalls: AgentToolCall[];
  artifacts: AgentArtifact[];
  managedProcesses: AgentManagedProcess[];
  userInputRequests: AgentUserInputRequest[];
  modelUsage?: AgentModelUsageStats;
  timeline: { flat: FlatTimelineItem[] };
  cursor: { latestMessageRowId: number | null };
}
