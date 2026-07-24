import { MODEL_TOKEN_PROFILES } from './model-profiles.js';

export const DASHSCOPE_OPENAI_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

export type ModelProvider = 'dashscope' | 'openai-compatible';

export interface ModelTokenOverrides {
  contextWindowTokens: number | null;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
}

export interface ModelConfig {
  provider: ModelProvider;
  apiKey: string;
  baseURL: string;
  modelName: string;
  temperature: number;
  streaming: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  tokens: ModelTokenOverrides;
}

export interface ResolvedModelTokenLimits {
  profileId?: string;
  contextWindowTokens: number;
  outputTokenLimit: number;
  inputTokenLimit: number;
}

export const DEFAULT_MODEL_CONFIG: Readonly<ModelConfig> = Object.freeze({
  provider: 'dashscope',
  apiKey: '',
  baseURL: DASHSCOPE_OPENAI_BASE_URL,
  modelName: 'qwen3.7-max',
  temperature: 0,
  streaming: true,
  requestTimeoutMs: 120_000,
  maxRetries: 2,
  tokens: {
    contextWindowTokens: null,
    inputTokenLimit: null,
    outputTokenLimit: 4_096,
  },
});

export function resolveModelTokenLimits(
  model: Pick<ModelConfig, 'provider' | 'modelName' | 'tokens'>
): ResolvedModelTokenLimits {
  const profile = MODEL_TOKEN_PROFILES.find(candidate => (
    candidate.provider === model.provider
    && candidate.modelPattern.test(model.modelName)
  ));
  const contextWindowTokens =
    model.tokens.contextWindowTokens ?? profile?.contextWindowTokens;
  if (!contextWindowTokens) {
    throw new Error(
      `No token profile is registered for ${model.provider}/${model.modelName}. `
      + 'Configure model.tokens.contextWindowTokens or add a model profile.'
    );
  }
  const outputTokenLimit =
    model.tokens.outputTokenLimit ?? profile?.outputTokenLimit ?? 4_096;
  if (
    profile?.providerMaxOutputTokens
    && outputTokenLimit > profile.providerMaxOutputTokens
  ) {
    throw new RangeError(
      `Model outputTokenLimit ${outputTokenLimit} exceeds provider limit `
      + `${profile.providerMaxOutputTokens} for ${model.modelName}.`
    );
  }
  if (outputTokenLimit >= contextWindowTokens) {
    throw new RangeError('Model outputTokenLimit must be smaller than contextWindowTokens.');
  }
  const maximumInputTokens = contextWindowTokens - outputTokenLimit;
  const inputTokenLimit = model.tokens.inputTokenLimit ?? maximumInputTokens;
  if (inputTokenLimit > maximumInputTokens) {
    throw new RangeError(
      `Model inputTokenLimit ${inputTokenLimit} does not reserve `
      + `${outputTokenLimit} output tokens inside context window ${contextWindowTokens}.`
    );
  }
  return {
    ...(profile ? { profileId: profile.id } : {}),
    contextWindowTokens,
    outputTokenLimit,
    inputTokenLimit,
  };
}
