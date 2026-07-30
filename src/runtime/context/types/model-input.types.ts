import type { BaseMessage } from '@langchain/core/messages';
import type { AgentContextInputManifest, AgentMessage } from '../../../domain/index.js';

export const MODEL_INPUT_CONTEXT_RULES_VERSION = 'model-input-v4';

export interface ModelInput {
  messages: BaseMessage[];
  estimatedTokens: number;
  inputTokenLimit: number;
  includedMessageIds: string[];
  compactedThroughRowId?: number;
  projectedToolResultMessageIds: string[];
  inputManifest: AgentContextInputManifest;
}

export interface ModelMessageGroup {
  id: string;
  messages: AgentMessage[];
  estimatedTokens: number;
  minRowId: number;
  maxRowId: number;
  contextScope: 'conversation' | 'task';
}
