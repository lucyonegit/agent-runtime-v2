export const AGENT_MODEL_CALL_TYPES = [
  'planner.route',
  'planner.create',
  'job.react',
  'step.react',
  'step.output_repair',
  'plan.finalize',
  'context.compress',
  'code.react',
] as const;

export type AgentModelCallType = typeof AGENT_MODEL_CALL_TYPES[number];
export type AgentModelCallStatus = 'started' | 'completed' | 'failed' | 'cancelled';
export type AgentModelUsageSource = 'provider' | 'estimated' | 'mixed' | 'unavailable';

export interface AgentContextInputManifest {
  purpose: string;
  contextRulesVersion: string;
  systemPromptVersion: string;
  messageGroupIds: string[];
  summaryIds: string[];
  includedRowIdStart?: number;
  includedRowIdEnd?: number;
  toolSchemaChecksum?: string;
  fixedPrefixChecksum: string;
  estimatedBreakdown: {
    system: number;
    tools: number;
    summaries: number;
    messages: number;
    reservedOutput: number;
  };
}

export interface AgentModelCall {
  id: string;
  sessionId: string;
  jobId: string;
  stepRunId?: string;
  attemptId: string;
  logicalCallKey: string;
  callAttemptNo: number;
  callType: AgentModelCallType;
  status: AgentModelCallStatus;
  provider: string;
  model: string;
  contextRulesVersion: string;
  inputManifest: AgentContextInputManifest;
  inputChecksum: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  estimatedInputTokens: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualTotalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  usageSource: AgentModelUsageSource;
  outputId?: string;
  resultType?: string;
  resultPayload?: unknown;
  toolNames?: string[];
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: unknown;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  completedAtMs?: number;
}

export interface AgentModelUsageStats {
  sessionId: string;
  totalModelCalls: number;
  totalEstimatedInputTokens: number;
  totalActualInputTokens: number;
  totalActualOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheWriteInputTokens: number;
  totalTokens: number;
  latestModelCallId?: string;
  latestModel?: string;
  latestContextUsageRatio?: number;
  maxContextTokens?: number;
  warningLevel: 'normal' | 'high' | 'critical';
  version: number;
  updatedAtMs: number;
}
