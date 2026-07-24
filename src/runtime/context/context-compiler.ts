import type { AgentContextInputManifest } from '../../domain/index.js';
import { evaluateContextPressure } from './helpers/model-budget.helper.js';
import { selectContextMaterial } from './helpers/context-selection.helper.js';
import type {
  CompiledContext,
  ContextMaterial,
} from './types/context.types.js';

export const CONTEXT_RULES_VERSION = 'unified-react-context-v2';
export const TOKEN_ESTIMATOR_VERSION = 'cjk-aware-v2';

export function compileContext(material: ContextMaterial): CompiledContext {
  const selected = selectContextMaterial(material);
  const pressure = evaluateContextPressure(
    selected.predictedCandidateTokens,
    selected.hardInputLimit,
    material.contextConfig
  );
  const inputManifest: AgentContextInputManifest = {
    purpose: material.audit.purpose,
    contextRulesVersion: material.audit.contextRulesVersion,
    systemPromptVersion: material.audit.systemPromptVersion,
    ...(material.audit.prompt ? { prompt: material.audit.prompt } : {}),
    messageGroupIds: selected.groupIds,
    summaryIds: selected.summaryIds,
    ...(material.bundles ? { selectedBundleIds: selected.bundleIds } : {}),
    ...(material.bundles ? {
      summarizedBundleIds: material.summaries.flatMap(summary => summary.sourceBundleIds ?? []),
    } : {}),
    ...(selected.coveredGroupIds.length > 0
      ? { summarizedMessageGroupIds: selected.coveredGroupIds }
      : {}),
    ...(selected.truncatedToolResultMessageIds.length > 0 ? {
      truncatedToolResultMessageIds: [...new Set(selected.truncatedToolResultMessageIds)],
    } : {}),
    ...(selected.includedRowIdStart === undefined ? {} : {
      includedRowIdStart: selected.includedRowIdStart,
      includedRowIdEnd: selected.includedRowIdEnd,
    }),
    ...(selected.toolSchemaChecksum
      ? { toolSchemaChecksum: selected.toolSchemaChecksum }
      : {}),
    fixedPrefixChecksum: selected.fixedPrefixChecksum,
    estimatedBreakdown: selected.estimatedBreakdown,
    tokenPrediction: {
      estimatorVersion: TOKEN_ESTIMATOR_VERSION,
      calibrationSampleCount: material.model.tokenCalibrationSampleCount ?? 0,
      calibrationFactor: material.model.tokenCalibrationFactor ?? 1,
      errorReserve: material.model.tokenErrorReserve ?? 0,
      rawEstimatedInputTokens: selected.estimatedInputTokens,
      predictedInputTokens: selected.predictedInputTokens,
      predictedCandidateTokens: selected.predictedCandidateTokens,
      hardInputLimit: selected.hardInputLimit,
      pressureLevel: pressure.pressureLevel,
    },
  };

  return {
    messages: selected.messages,
    inputManifest,
    estimatedInputTokens: selected.estimatedInputTokens,
    predictedInputTokens: selected.predictedInputTokens,
    predictedCandidateTokens: selected.predictedCandidateTokens,
    hardInputLimit: selected.hardInputLimit,
    pressureLevel: pressure.pressureLevel,
    contextRulesVersion: material.audit.contextRulesVersion,
    summaryIds: selected.summaryIds,
    mustKeepMessageIds: selected.mustKeepMessageIds,
    compressibleMessageIds: selected.compressibleMessageIds,
    shouldCompress: !material.compression.disabled && pressure.shouldCompress,
    mustCompress: !material.compression.disabled && pressure.mustCompress,
    annotations: selected.annotations,
    blockedDiagnostics: selected.blockedDiagnostics,
  };
}
