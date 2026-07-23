import type {
  AgentArtifact,
  AgentJob,
  AgentMessage,
  AgentManagedProcess,
  AgentModelUsageStats,
  AgentPlan,
  AgentPlanStep,
  AgentSession,
  AgentToolInvocation,
  AgentUserInputRequest,
} from '../domain/index.js';

export type FlatTimelineItem =
  | { type: 'message'; rowId: number; message: AgentMessage }
  | {
      type: 'tool_exchange';
      rowId: number;
      callMessage: AgentMessage;
      invocations: AgentToolInvocation[];
      resultMessages: AgentMessage[];
      artifacts: AgentArtifact[];
      status: 'pending' | 'running' | 'waiting_user_input' | 'completed' | 'failed' | 'unknown' | 'cancelled';
      warning?: string;
    };

export interface SessionViewV1 {
  schemaVersion: 4;
  generatedAtMs: number;
  session: AgentSession;
  jobs: AgentJob[];
  plans: AgentPlan[];
  planSteps: AgentPlanStep[];
  messages: AgentMessage[];
  toolInvocations: AgentToolInvocation[];
  artifacts: AgentArtifact[];
  managedProcesses: AgentManagedProcess[];
  userInputRequests: AgentUserInputRequest[];
  modelUsage?: AgentModelUsageStats;
  timeline: {
    flat: FlatTimelineItem[];
  };
  cursor: { latestMessageRowId: number | null };
}
