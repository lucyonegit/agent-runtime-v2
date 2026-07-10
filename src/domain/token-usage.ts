export type AgentTokenUsageSource = 'provider' | 'estimated' | 'mixed' | 'unavailable';
export type AgentContextBuildStatus = 'started' | 'completed' | 'failed' | 'cancelled';

export type AgentContextBuildStrategyValue =
  | 'full'
  | 'snapshot_tail'
  | 'compressed_then_snapshot_tail'
  | 'tail_only_fallback';

export type AgentModelCallPurpose =
  | 'react.loop'
  | 'code.react.loop'
  | 'planner.route'
  | 'planner.direct.react'
  | 'planner.plan.create'
  | 'planner.plan.finalize'
  | 'planner.step.react';

export type AgentModelCallResultType =
  | 'assistant.normal'
  | 'assistant.final'
  | 'tool_calls'
  | 'planner.route'
  | 'planner.direct'
  | 'planner.plan'
  | 'planner.final'
  | 'unknown';

export interface AgentModelTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  source: AgentTokenUsageSource;
}

export interface AgentContextUsageBreakdown {
  system?: number;
  snapshot?: number;
  recentMessages?: number;
  toolSchemas?: number;
  plannerState?: number;
  reservedOutput?: number;
  [key: string]: number | undefined;
}

export interface AgentContextBuild {
  id: string;
  sessionId: string;
  taskId: string;
  parentTaskId?: string;
  taskKind?: string;
  executor?: string;
  snapshotId?: string;
  executionId?: string;
  callKey?: string;
  status: AgentContextBuildStatus;
  projectionVersion: string;
  model: string;
  callPurpose?: AgentModelCallPurpose;
  strategy: AgentContextBuildStrategyValue;
  maxContextTokens: number;
  reservedOutputTokens: number;
  estimatedInputTokens: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualTotalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  usageSource: AgentTokenUsageSource;
  contextUsageRatio?: number;
  includedRowIdStart?: number;
  includedRowIdEnd?: number;
  outputId?: string;
  outputChannel?: string;
  resultType?: AgentModelCallResultType;
  toolCallCount?: number;
  toolNames?: string[];
  breakdown: AgentContextUsageBreakdown;
  contextManifest?: Record<string, unknown>;
  error?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: number;
  completedAt?: number;
}

export interface AgentSessionTokenStats {
  sessionId: string;
  totalModelCalls: number;
  totalEstimatedInputTokens: number;
  totalActualInputTokens: number;
  totalActualOutputTokens: number;
  totalTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheWriteInputTokens: number;
  latestContextBuildId?: string;
  latestModel?: string;
  latestStrategy?: AgentContextBuildStrategyValue;
  latestEstimatedInputTokens?: number;
  latestActualInputTokens?: number;
  latestActualOutputTokens?: number;
  latestContextUsageRatio?: number;
  maxContextTokens?: number;
  warningLevel: 'normal' | 'high' | 'critical';
  updatedAt: number;
}
