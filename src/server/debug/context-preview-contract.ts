import type { AgentContextInputManifest } from '../../domain/index.js';

export interface ContextPreviewMessage {
  index: number;
  type: 'system' | 'human' | 'ai' | 'tool';
  content: unknown;
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

/** Sensitive diagnostic projection of the actual LangChain input list. */
export interface ContextPreviewV2 {
  schemaVersion: 2;
  debugOnly: true;
  generatedAtMs: number;
  sessionId: string;
  basedOnLatestTaskId?: string;
  query: {
    kind: 'next_turn' | 'task' | 'model_call';
    sessionId?: string;
    taskId?: string;
    modelCallId?: string;
  };
  verification: { status: 'reconstructed' | 'exact'; checksumMatched?: boolean };
  systemPromptVersion: string;
  estimatedInputTokens: number;
  limits: {
    contextWindowTokens: number;
    outputTokenLimit: number;
    inputTokenLimit: number;
  };
  compactedThroughRowId?: number;
  projectedToolResultMessageIds: string[];
  manifest: AgentContextInputManifest;
  messages: ContextPreviewMessage[];
}
