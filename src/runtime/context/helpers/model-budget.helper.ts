import type { AgentModelCall } from '../../../domain/index.js';
import {
  DEFAULT_CONTEXT_CONFIG,
  type ContextConfig,
} from '../../../config/runtime-config.js';
import type {
  ContextModelBudget,
  ContextPressureLevel,
} from '../types/context.types.js';

export const CONTEXT_COMPRESSION_START_RATIO =
  DEFAULT_CONTEXT_CONFIG.pressure.compressRatio;
export const CONTEXT_COMPRESSION_REQUIRED_RATIO =
  DEFAULT_CONTEXT_CONFIG.pressure.mustCompressRatio;

export function calibrateModelBudget(
  model: ContextModelBudget,
  calls: AgentModelCall[],
  config: ContextConfig = DEFAULT_CONTEXT_CONFIG
): ContextModelBudget {
  const samples = calls.filter(call => (
    call.status === 'completed'
    && call.callType === 'job.react'
    && call.provider === model.provider
    && call.model === model.name
    && typeof call.actualInputTokens === 'number'
    && call.actualInputTokens > 0
    && rawEstimatedInputTokens(call) > 0
  )).slice(-config.estimation.historySampleSize);
  if (samples.length < config.estimation.minimumCalibrationSamples) {
    return {
      ...model,
      tokenCalibrationFactor: model.tokenCalibrationFactor
        ?? config.estimation.fallbackCalibrationFactor,
      tokenErrorReserve: model.tokenErrorReserve
        ?? config.estimation.fallbackErrorReserveTokens,
      tokenCalibrationSampleCount: samples.length,
    };
  }
  const ratios = samples
    .map(call => call.actualInputTokens! / rawEstimatedInputTokens(call))
    .sort((left, right) => left - right);
  const factor = Math.min(
    config.estimation.maximumCalibrationFactor,
    Math.max(
      config.estimation.minimumCalibrationFactor,
      percentile(ratios, config.estimation.calibrationPercentile)
    )
  );
  const residuals = samples
    .map(call => Math.max(
      0,
      call.actualInputTokens! - rawEstimatedInputTokens(call) * factor
    ))
    .sort((left, right) => left - right);
  return {
    ...model,
    tokenCalibrationFactor: factor,
    tokenErrorReserve: Math.max(
      config.estimation.minimumErrorReserveTokens,
      Math.ceil(percentile(residuals, config.estimation.calibrationPercentile))
    ),
    tokenCalibrationSampleCount: samples.length,
  };
}

export function evaluateContextPressure(
  predictedTokens: number,
  inputTokenLimit: number,
  config: ContextConfig = DEFAULT_CONTEXT_CONFIG
): {
  shouldCompress: boolean;
  mustCompress: boolean;
  pressureLevel: ContextPressureLevel;
} {
  const ratio = inputTokenLimit > 0 ? predictedTokens / inputTokenLimit : 1;
  const pressureLevel = ratio >= config.pressure.criticalRatio
    ? 'critical'
    : ratio >= config.pressure.mustCompressRatio
      ? 'mandatory'
      : ratio >= config.pressure.compressRatio
        ? 'compact'
        : ratio >= config.pressure.watchRatio
          ? 'watch'
          : 'normal';
  return {
    shouldCompress: ratio >= config.pressure.compressRatio,
    mustCompress: ratio >= config.pressure.mustCompressRatio,
    pressureLevel,
  };
}

function rawEstimatedInputTokens(call: AgentModelCall): number {
  return call.inputManifest.tokenPrediction?.rawEstimatedInputTokens
    ?? call.estimatedInputTokens;
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index]!;
}
