import type { AgentTaskStatus } from './task.js';

export type AgentPlanStatus = Extract<
  AgentTaskStatus,
  'created' | 'running' | 'waiting_user_input' | 'completed' | 'failed' | 'cancelled'
>;

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
  rootTaskId: string;
  title: string;
  status: AgentPlanStatus;
  version: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface AgentPlanStep {
  id: string;
  planId: string;
  taskId?: string;
  position: number;
  title: string;
  instruction: string;
  status: AgentPlanStepStatus;
  resultMessageId?: string;
  error?: {
    message: string;
    details?: unknown;
    failedAt: number;
  };
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
