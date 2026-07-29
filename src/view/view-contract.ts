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
  schemaVersion: 5;
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
