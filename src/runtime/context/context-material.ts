import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { MessageGroup } from './message-group-builder.js';

export interface ContextFixedMessage {
  id: string;
  message: BaseMessage;
  text: string;
}

export interface ContextGroupMaterial {
  group: MessageGroup;
  segment: 'session_history' | 'current_job' | 'current_plan' | 'current_step';
  mustKeep: boolean;
  priority: number;
}

export interface ContextSummaryMaterial {
  id: string;
  summary: string;
  sourceRowIdEnd?: number;
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
  summaries: ContextSummaryMaterial[];
  toolSchemas: StructuredToolInterface[];
  model: ContextModelBudget;
  audit: {
    purpose: string;
    contextRulesVersion: string;
    systemPromptVersion: string;
  };
  compression: {
    disabled: boolean;
    newCompressibleMessageCount: number;
    messageThreshold: number;
    candidateMessageIds?: string[];
  };
}
