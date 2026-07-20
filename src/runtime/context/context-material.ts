import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { MessageGroup } from './message-group-builder.js';

export type ContextSegment =
  | 'session_history'
  | 'current_job';

export interface ContextFixedMessage {
  id: string;
  message: BaseMessage;
  text: string;
}

export interface ContextGroupMaterial {
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

export interface ContextSummaryMaterial {
  id: string;
  summary: string;
  sourceRowIdEnd?: number;
  sourceBundleIds?: string[];
}

export interface ContextModelBudget {
  provider: string;
  name: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
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
    newCompressibleMessageCount: number;
    messageThreshold: number;
    candidateMessageIds?: string[];
  };
}
