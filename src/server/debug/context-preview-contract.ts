import type { AgentContextInputManifest } from '../../domain/index.js';
import type { CompiledContextAnnotation } from '../../runtime/context/context-material.js';

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
  source?: CompiledContextAnnotation;
}

export interface ContextPreviewV1 {
  schemaVersion: 1;
  debugOnly: true;
  generatedAtMs: number;
  sessionId: string;
  basedOnLatestJobId?: string;
  query: {
    kind: 'next_turn' | 'job' | 'model_call';
    sessionId?: string;
    jobId?: string;
    modelCallId?: string;
  };
  verification: {
    status: 'reconstructed' | 'exact';
    checksumMatched?: boolean;
  };
  contextRulesVersion: string;
  systemPromptVersion: string;
  estimatedInputTokens: number;
  compressionRecommended: boolean;
  limits: {
    maxContextTokens: number;
    reservedOutputTokens: number;
  };
  manifest: AgentContextInputManifest;
  selection: {
    selectedBundleIds: string[];
    summarizedBundleIds: string[];
    truncatedToolResultMessageIds: string[];
  };
  blockedDiagnostics: Array<{
    messageId: string;
    reason: string;
    toolCallId?: string;
  }>;
  messages: ContextPreviewMessage[];
}
