import type {
  AgentCodeProject,
  AgentJob,
  AgentMessage,
  AgentModelUsageStats,
  AgentPlan,
  AgentPlanStep,
  AgentSession,
  AgentStepRun,
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
      status: 'pending' | 'running' | 'waiting_user_input' | 'completed' | 'failed' | 'unknown' | 'cancelled';
      warning?: string;
    };

export interface StepTimelineGroup {
  type: 'step_group';
  jobId: string;
  plan?: AgentPlan;
  step?: AgentPlanStep;
  stepRun?: AgentStepRun;
  status: string;
  items: FlatTimelineItem[];
}

export interface JobTimelineGroup {
  type: 'job_group';
  job: AgentJob;
  items: Array<FlatTimelineItem | StepTimelineGroup>;
}

export interface SessionViewV1 {
  schemaVersion: 1;
  generatedAtMs: number;
  session: AgentSession;
  jobs: AgentJob[];
  plans: AgentPlan[];
  planSteps: AgentPlanStep[];
  stepRuns: AgentStepRun[];
  messages: AgentMessage[];
  toolInvocations: AgentToolInvocation[];
  userInputRequests: AgentUserInputRequest[];
  modelUsage?: AgentModelUsageStats;
  codeProjects: AgentCodeProject[];
  timeline: {
    flat: FlatTimelineItem[];
    groupedByStep: JobTimelineGroup[];
  };
  cursor: { latestMessageRowId: number | null };
}
