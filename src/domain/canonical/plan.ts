import type { AgentJobError } from './job.js';

export type AgentPlanStatus =
  | 'draft'
  | 'active'
  | 'waiting_user_input'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentPlanStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_user_input'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentPlan {
  id: string;
  sessionId: string;
  jobId: string;
  title: string;
  goal: string;
  status: AgentPlanStatus;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
}

export interface AgentPlanStep {
  id: string;
  planId: string;
  position: number;
  title: string;
  instruction: string;
  status: AgentPlanStepStatus;
  outputMessageId?: string;
  error?: AgentJobError;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
}
