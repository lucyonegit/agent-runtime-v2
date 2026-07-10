export enum AgentContextSnapshotKind {
  RollingSummary = 'rolling_summary',
  TaskSummary = 'task_summary',
  ToolSummary = 'tool_summary',
  MemorySummary = 'memory_summary',
  ConversationSummary = 'conversation_summary',
  ProjectInvariants = 'project_invariants',
  ProjectIndex = 'project_index',
  WorkingSetSummary = 'working_set_summary',
}

export enum AgentContextSnapshotStatus {
  Active = 'active',
  Superseded = 'superseded',
  Failed = 'failed',
}

export enum AgentContextBuildStrategy {
  Full = 'full',
  SnapshotTail = 'snapshot_tail',
  CompressedThenSnapshotTail = 'compressed_then_snapshot_tail',
  TailOnlyFallback = 'tail_only_fallback',
}

export type AgentContextScopeKind = 'session' | 'task' | 'planner_step' | 'code_project';
export type AgentContextPurpose =
  | 'conversation'
  | 'task_execution'
  | 'planner_step'
  | 'planner_final'
  | 'code_project';

export interface AgentContextSnapshot {
  id: string;
  sessionId: string;
  taskId?: string;
  scopeKind: AgentContextScopeKind;
  scopeId: string;
  purpose: AgentContextPurpose;
  projectionVersion: string;
  kind: AgentContextSnapshotKind;
  status: AgentContextSnapshotStatus;
  sourceRowIdStart: number;
  sourceRowIdEnd: number;
  baseSnapshotId?: string;
  supersedesSnapshotId?: string;
  summary: string;
  summaryFormat: 'markdown' | 'json';
  sourceMessageCount: number;
  sourceTokenCount?: number;
  summaryTokenCount?: number;
  model?: string;
  compressionPromptVersion: string;
  checksum?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
