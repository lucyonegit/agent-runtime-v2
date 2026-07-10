export interface TokenBudgetConfig {
  maxContextTokens: number;
  reservedOutputTokens: number;
  compressionTriggerRatio: number;
  minTailMessages: number;
  minTailTokens: number;
  maxSnapshotTokens: number;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudgetConfig = {
  maxContextTokens: 32000,
  reservedOutputTokens: 4000,
  compressionTriggerRatio: 0.75,
  minTailMessages: 12,
  minTailTokens: 4000,
  maxSnapshotTokens: 3000,
};

export class ApproximateTokenEstimator {
  countText(text: string): number {
    return Math.ceil(text.length / 3);
  }
}

export class TokenBudgetManager {
  constructor(private readonly config: TokenBudgetConfig = DEFAULT_TOKEN_BUDGET) {}

  maxInputTokens(): number {
    return this.config.maxContextTokens - this.config.reservedOutputTokens;
  }

  compressionThreshold(): number {
    return Math.floor(this.maxInputTokens() * this.config.compressionTriggerRatio);
  }

  shouldCompress(estimatedInputTokens: number): boolean {
    return estimatedInputTokens > this.compressionThreshold();
  }

  getConfig(): TokenBudgetConfig {
    return this.config;
  }
}
