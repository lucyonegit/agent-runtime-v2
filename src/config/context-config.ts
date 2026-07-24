export interface ContextConfig {
  compression: {
    enabled: boolean;
    maximumPasses: number;
    recentRawTokenBudget: number;
    minimumRecentGroups: number;
    batchMinimumTokens: number;
    batchMaximumTokens: number;
    batchInputFraction: number;
  };
  pressure: {
    watchRatio: number;
    compressRatio: number;
    mustCompressRatio: number;
    criticalRatio: number;
  };
  estimation: {
    historySampleSize: number;
    minimumCalibrationSamples: number;
    fallbackCalibrationFactor: number;
    minimumCalibrationFactor: number;
    maximumCalibrationFactor: number;
    calibrationPercentile: number;
    fallbackErrorReserveTokens: number;
    minimumErrorReserveTokens: number;
  };
  projection: {
    maximumToolResultTokens: number;
    toolResultHeadRatio: number;
    runtimeStateMaximumTokens: number;
    artifactHistoryLimit: number;
    recentModelCallLimit: number;
  };
}

export const DEFAULT_CONTEXT_CONFIG: Readonly<ContextConfig> = Object.freeze({
  compression: {
    enabled: true,
    maximumPasses: 4,
    recentRawTokenBudget: 24_000,
    minimumRecentGroups: 2,
    batchMinimumTokens: 8_000,
    batchMaximumTokens: 48_000,
    batchInputFraction: 0.5,
  },
  pressure: {
    watchRatio: 0.4,
    compressRatio: 0.55,
    mustCompressRatio: 0.75,
    criticalRatio: 0.9,
  },
  estimation: {
    historySampleSize: 100,
    minimumCalibrationSamples: 10,
    fallbackCalibrationFactor: 1.1,
    minimumCalibrationFactor: 1,
    maximumCalibrationFactor: 1.75,
    calibrationPercentile: 0.95,
    fallbackErrorReserveTokens: 256,
    minimumErrorReserveTokens: 64,
  },
  projection: {
    maximumToolResultTokens: 8_000,
    toolResultHeadRatio: 0.6,
    runtimeStateMaximumTokens: 8_000,
    artifactHistoryLimit: 100,
    recentModelCallLimit: 100,
  },
});
