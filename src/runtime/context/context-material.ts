import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentContextSummaryType } from '../../domain/index.js';
import type { MessageGroup } from './message-group-builder.js';

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
  /** P95(actual / estimated) learned from completed calls for this model. */
  tokenCalibrationFactor?: number;
  /** Fixed framing/tool-schema error observed in historical calls. */
  tokenErrorReserve?: number;
  tokenCalibrationSampleCount?: number;
}

export interface ContextMaterial {
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
    /** Start compacting before the selection reaches the hard model limit. */
    compactAtRatio?: number;
    candidateMessageIds?: string[];
  };
}
