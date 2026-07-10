import type { ContextPurpose } from './context-purpose.js';

export interface CompressionDecisionInput {
  purpose: ContextPurpose;
  candidateTokens: number;
  safeInputLimit: number;
  newCompressibleMessageCount: number;
  messageThreshold: number;
  projectChecksumInvalid?: boolean;
}

export class ContextSummaryManager {
  shouldCompress(input: CompressionDecisionInput): boolean {
    if (input.purpose === 'context_compression') return false;
    return input.candidateTokens > input.safeInputLimit * 0.7
      || input.newCompressibleMessageCount >= input.messageThreshold
      || input.projectChecksumInvalid === true;
  }
}
