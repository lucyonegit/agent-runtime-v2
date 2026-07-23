import type { AgentModelCall } from '../../../domain/index.js';
import type {
  ContextModelBudget,
  ContextPressureLevel,
} from '../types/context.types.js';

export const CONTEXT_COMPRESSION_START_RATIO = 0.55;
export const CONTEXT_COMPRESSION_REQUIRED_RATIO = 0.75;

export function calibrateModelBudget(
  model: ContextModelBudget,
  calls: AgentModelCall[]
): ContextModelBudget {
  const samples = calls.filter(call => (
    call.status === 'completed'
    && call.callType === 'job.react'
    && call.provider === model.provider
    && call.model === model.name
    && typeof call.actualInputTokens === 'number'
    && call.actualInputTokens > 0
    && rawEstimatedInputTokens(call) > 0
  )).slice(-100);
  if (samples.length < 10) {
    return {
      ...model,
      tokenCalibrationFactor: model.tokenCalibrationFactor ?? 1.1,
      tokenErrorReserve: model.tokenErrorReserve ?? 256,
      tokenCalibrationSampleCount: samples.length,
    };
  }
  const ratios = samples
    .map(call => call.actualInputTokens! / rawEstimatedInputTokens(call))
    .sort((left, right) => left - right);
  const factor = Math.min(1.75, Math.max(1, percentile(ratios, 0.95)));
  const residuals = samples
    .map(call => Math.max(
      0,
      call.actualInputTokens! - rawEstimatedInputTokens(call) * factor
    ))
    .sort((left, right) => left - right);
  return {
    ...model,
    tokenCalibrationFactor: factor,
    tokenErrorReserve: Math.max(64, Math.ceil(percentile(residuals, 0.95))),
    tokenCalibrationSampleCount: samples.length,
  };
}

export function evaluateContextPressure(
  predictedTokens: number,
  inputTokenLimit: number
): {
  shouldCompress: boolean;
  mustCompress: boolean;
  pressureLevel: ContextPressureLevel;
} {
  const ratio = inputTokenLimit > 0 ? predictedTokens / inputTokenLimit : 1;
  const pressureLevel = ratio >= 0.9
    ? 'critical'
    : ratio >= CONTEXT_COMPRESSION_REQUIRED_RATIO
      ? 'mandatory'
      : ratio >= CONTEXT_COMPRESSION_START_RATIO
        ? 'compact'
        : ratio >= 0.4
          ? 'watch'
          : 'normal';
  return {
    shouldCompress: ratio >= CONTEXT_COMPRESSION_START_RATIO,
    mustCompress: ratio >= CONTEXT_COMPRESSION_REQUIRED_RATIO,
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
