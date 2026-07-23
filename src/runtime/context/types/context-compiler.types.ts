import type { BaseMessage } from '@langchain/core/messages';
import type {
  CompiledContextAnnotation,
  ContextMaterial,
} from './context.types.js';

export interface ContextSelection {
  messages: BaseMessage[];
  groupIds: string[];
  summaryIds: string[];
  bundleIds: string[];
  coveredGroupIds: string[];
  truncatedToolResultMessageIds: string[];
  annotations: CompiledContextAnnotation[];
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
  estimatedInputTokens: number;
  predictedInputTokens: number;
  predictedCandidateTokens: number;
  hardInputLimit: number;
  mustKeepMessageIds: string[];
  compressibleMessageIds: string[];
  blockedDiagnostics: NonNullable<ContextMaterial['blockedDiagnostics']>;
}
