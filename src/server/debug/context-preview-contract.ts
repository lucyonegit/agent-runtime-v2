import type { AgentContextInputManifest } from '../../domain/index.js';

export interface ContextPreviewMessage {
  index: number;
  type: 'system' | 'human' | 'ai' | 'tool';
  content: unknown;
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

export interface ContextPreviewV1 {
  schemaVersion: 1;
  debugOnly: true;
  generatedAtMs: number;
  sessionId: string;
  basedOnLatestJobId?: string;
  contextRulesVersion: string;
  systemPromptVersion: string;
  estimatedInputTokens: number;
  compressionRecommended: boolean;
  limits: {
    maxContextTokens: number;
    reservedOutputTokens: number;
  };
  manifest: AgentContextInputManifest;
  messages: ContextPreviewMessage[];
}
