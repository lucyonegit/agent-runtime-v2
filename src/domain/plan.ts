export type AgentPlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentPlanStep {
  step: string;
  status: AgentPlanStepStatus;
}

/** Session-level singleton owned by the Task that is currently executing it. */
export interface AgentActivePlan {
  sessionId: string;
  taskId: string;
  title: string;
  steps: AgentPlanStep[];
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}
