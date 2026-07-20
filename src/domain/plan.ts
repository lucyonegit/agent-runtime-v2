import type { AgentJobError } from './job.js';

export type AgentPlanStatus =
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentPlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface AgentPlanStepResult {
  summary?: string;
  evidenceMessageIds?: string[];
  artifactIds?: string[];
}

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
  key: string;
  position: number;
  title: string;
  description?: string;
  status: AgentPlanStepStatus;
  result?: AgentPlanStepResult;
  error?: AgentJobError;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
}
