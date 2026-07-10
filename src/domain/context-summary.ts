export const AGENT_CONTEXT_OWNER_TYPES = ['session', 'job', 'step_run', 'code_project'] as const;
export const AGENT_CONTEXT_PURPOSES = [
  'conversation',
  'job_execution',
  'step_execution',
  'plan_final',
  'code_execution',
] as const;

export type AgentContextOwnerType = typeof AGENT_CONTEXT_OWNER_TYPES[number];
export type AgentContextPurpose = typeof AGENT_CONTEXT_PURPOSES[number];
export type AgentContextSummaryType =
  | 'rolling'
  | 'job'
  | 'tool_history'
  | 'project_invariants'
  | 'project_index'
  | 'working_set';
export type AgentContextSummaryStatus = 'active' | 'superseded' | 'failed';

export interface AgentContextSummary {
  id: string;
  sessionId: string;
  jobId?: string;
  stepRunId?: string;
  projectId?: string;
  ownerType: AgentContextOwnerType;
  ownerId: string;
  purpose: AgentContextPurpose;
  contextRulesVersion: string;
  summaryType: AgentContextSummaryType;
  status: AgentContextSummaryStatus;
  sourceRowIdStart: number;
  sourceRowIdEnd: number;
  parentSummaryId?: string;
  replacesSummaryId?: string;
  summary: string;
  summaryFormat: 'markdown' | 'json';
  sourceMessageCount: number;
  sourceTokenCount?: number;
  summaryTokenCount?: number;
  model?: string;
  compressionPromptVersion: string;
  checksum: string;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
}
