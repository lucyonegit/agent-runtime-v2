import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ContextConfig } from '../../../config/runtime-config.js';
import type {
  AgentContextInputManifest,
  AgentContextSummaryType,
  AgentPromptManifest,
} from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import type { MessageGroup } from './message-group.types.js';

type ContextSegment =
  | 'session_history'
  | 'current_job';

interface ContextFixedMessage {
  id: string;
  message: BaseMessage;
  text: string;
}

interface ContextGroupMaterial {
  group: MessageGroup;
  segment: ContextSegment;
  mustKeep: boolean;
  priority: number;
}

export interface TurnBundle {
  id: string;
  type: 'turn';
  sessionId: string;
  rootJobId: string;
  jobIds: string[];
  terminal: boolean;
  sourceRowIdStart: number;
  sourceRowIdEnd: number;
  groups: MessageGroup[];
}

export interface ContextBundleMaterial {
  bundle: TurnBundle;
  segment: ContextSegment;
  mustKeep: boolean;
  priority: number;
}

export interface CompiledContextAnnotation {
  sourceMessageId?: string;
  groupId: string;
  bundleId?: string;
  projected?: boolean;
  truncated?: boolean;
  originalTokenEstimate?: number;
  projectedTokenEstimate?: number;
  checksum?: string;
}

interface ContextSummaryMaterial {
  id: string;
  summaryType?: AgentContextSummaryType;
  compressionPromptVersion?: string;
  summary: string;
  sourceRowIdStart?: number;
  sourceRowIdEnd?: number;
  sourceGroupIds?: string[];
  sourceBundleIds?: string[];
  sourceMessageCount?: number;
  sourceTokenCount?: number;
}

export interface ContextModelBudget {
  provider: string;
  name: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  /** Provider/deployment input ceiling after reserving this call's output. */
  inputTokenLimit?: number;
  /** P95(actual / estimated) learned from completed calls for this model. */
  tokenCalibrationFactor?: number;
  /** Fixed framing/tool-schema error observed in historical calls. */
  tokenErrorReserve?: number;
  tokenCalibrationSampleCount?: number;
}

export interface ContextMaterial {
  contextConfig?: ContextConfig;
  fixedMessages: ContextFixedMessage[];
  trailingMessages?: ContextFixedMessage[];
  fixedPrefix: Record<string, unknown>;
  groups: ContextGroupMaterial[];
  bundles?: ContextBundleMaterial[];
  summaries: ContextSummaryMaterial[];
  toolSchemas: StructuredToolInterface[];
  model: ContextModelBudget;
  audit: {
    purpose: string;
    contextRulesVersion: string;
    systemPromptVersion: string;
    prompt?: AgentPromptManifest;
  };
  blockedDiagnostics?: Array<{
    messageId: string;
    reason: string;
    toolCallId?: string;
  }>;
  compression: {
    disabled: boolean;
    /** Raw tail retained verbatim even when older groups are compressed. */
    recentRawTokenBudget?: number;
    minimumRecentGroups?: number;
    /** Goal and other protocol-critical messages which must remain raw. */
    protectedMessageIds?: string[];
    candidateMessageIds?: string[];
  };
}

export type ContextPressureLevel =
  | 'normal'
  | 'watch'
  | 'compact'
  | 'mandatory'
  | 'critical';

export interface CompiledContext {
  messages: BaseMessage[];
  inputManifest: AgentContextInputManifest;
  estimatedInputTokens: number;
  predictedInputTokens: number;
  predictedCandidateTokens: number;
  hardInputLimit: number;
  pressureLevel: ContextPressureLevel;
  contextRulesVersion: string;
  summaryIds: string[];
  mustKeepMessageIds: string[];
  compressibleMessageIds: string[];
  shouldCompress: boolean;
  mustCompress: boolean;
  annotations: CompiledContextAnnotation[];
  blockedDiagnostics: NonNullable<ContextMaterial['blockedDiagnostics']>;
}

export type BuiltContext = CompiledContext;

export interface TokenBudgetItem<T> {
  id: string;
  value: T;
  estimatedTokens: number;
  mustKeep: boolean;
  priority: number;
  recency: number;
  originalOrder: number;
}

export interface ReActContextStore {
  sessions: Pick<AgentStore['sessions'],
    | 'listJobs'
    | 'listMessages'
    | 'listToolInvocations'
    | 'listPlans'
    | 'listPlanSteps'
    | 'listArtifacts'
    | 'listUserInputRequests'
  >;
  models: Pick<AgentStore['models'], 'listRecentSessionCalls'>;
  context: Pick<AgentStore['context'], 'listActiveSummaries'>
    & Partial<Pick<AgentStore['context'], 'replaceSummary'>>;
}

export interface ReActContextMaterialOptions {
  store: ReActContextStore;
  systemPrompt: string;
  systemPromptVersion: string;
  model: ContextModelBudget;
  toolSchemas: StructuredToolInterface[];
  promptId?: string;
  promptVersion?: number;
  getStableContext?: (sessionId: string) => string | undefined;
  recentRawTokenBudget?: number;
  minimumRecentGroups?: number;
  contextConfig?: ContextConfig;
}
