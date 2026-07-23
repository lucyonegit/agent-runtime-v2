import type {
  AgentContextInputManifest,
  AgentPromptManifest,
} from '../../domain/index.js';
import type {
  CompiledContextAnnotation,
} from '../../runtime/context/types/context.types.js';

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
  prompt?: AgentPromptManifest;
  estimatedInputTokens: number;
  predictedInputTokens: number;
  predictedCandidateTokens: number;
  pressureLevel: 'normal' | 'watch' | 'compact' | 'mandatory' | 'critical';
  shouldCompress: boolean;
  mustCompress: boolean;
  limits: {
    maxContextTokens: number;
    reservedOutputTokens: number;
    contextWindowTokens: number;
    outputTokenLimit: number;
    inputTokenLimit: number;
  };
  manifest: AgentContextInputManifest;
  selection: {
    selectedBundleIds: string[];
    summarizedBundleIds: string[];
    summarizedMessageGroupIds: string[];
    truncatedToolResultMessageIds: string[];
  };
  blockedDiagnostics: Array<{
    messageId: string;
    reason: string;
    toolCallId?: string;
  }>;
  messages: ContextPreviewMessage[];
}
