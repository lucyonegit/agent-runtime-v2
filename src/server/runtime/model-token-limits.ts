import type { ModelRuntimeConfig } from './model-config.js';

const DEFAULT_OUTPUT_TOKEN_LIMIT = 4_096;

export interface ModelTokenProfile {
  id: string;
  provider: ModelRuntimeConfig['provider'];
  modelPattern: RegExp;
  contextWindowTokens: number;
  providerMaxOutputTokens?: number;
  outputTokenLimit: number;
}

export interface ResolvedModelTokenLimits {
  profileId?: string;
  contextWindowTokens: number;
  outputTokenLimit: number;
  inputTokenLimit: number;
}

/**
 * Built-in deployment defaults. Model limits are provider capabilities and
 * deployment policy, so they live next to model creation rather than in the
 * Session/Job persistence model.
 *
 * Runtime output stays capped at 4K even when a provider can generate more.
 * That makes the input budget deterministic; large deliverables should be
 * written through tools instead of returned in one model message.
 */
export const MODEL_TOKEN_PROFILES: readonly ModelTokenProfile[] = [
  {
    id: 'dashscope-qwen-3.7',
    provider: 'dashscope',
    modelPattern: /^qwen3\.7-(?:max|plus)(?:-|$)/i,
    contextWindowTokens: 1_000_000,
    providerMaxOutputTokens: 65_536,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
  {
    id: 'dashscope-qwen-3.6-plus-flash',
    provider: 'dashscope',
    modelPattern: /^qwen3\.6-(?:plus|flash)(?:-|$)/i,
    contextWindowTokens: 1_000_000,
    providerMaxOutputTokens: 65_536,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
  {
    id: 'dashscope-qwen-3.6-max',
    provider: 'dashscope',
    modelPattern: /^qwen3\.6-max(?:-|$)/i,
    contextWindowTokens: 262_144,
    providerMaxOutputTokens: 65_536,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
  {
    id: 'dashscope-qwen-3.5-plus-flash',
    provider: 'dashscope',
    modelPattern: /^qwen3\.5-(?:plus|flash)(?:-|$)/i,
    contextWindowTokens: 1_000_000,
    providerMaxOutputTokens: 65_536,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
  {
    id: 'dashscope-qwen-3-max',
    provider: 'dashscope',
    modelPattern: /^qwen3-max(?:-|$)/i,
    contextWindowTokens: 262_144,
    providerMaxOutputTokens: 65_536,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
  {
    id: 'dashscope-qwen-3-coder-long',
    provider: 'dashscope',
    modelPattern: /^qwen3-coder-(?:plus|flash)(?:-|$)/i,
    contextWindowTokens: 1_000_000,
    providerMaxOutputTokens: 65_536,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
  {
    id: 'dashscope-qwen-3-coder-256k',
    provider: 'dashscope',
    modelPattern: /^qwen3-coder-(?:next|480b-a35b-instruct|30b-a3b-instruct)(?:-|$)/i,
    contextWindowTokens: 262_144,
    providerMaxOutputTokens: 65_536,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
  {
    id: 'dashscope-qwen-plus',
    provider: 'dashscope',
    modelPattern: /^qwen-plus(?:-\d{4}-\d{2}-\d{2})?$/i,
    contextWindowTokens: 1_000_000,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
  {
    id: 'dashscope-qwen-max',
    provider: 'dashscope',
    modelPattern: /^qwen-max(?:-\d{4}-\d{2}-\d{2})?$/i,
    contextWindowTokens: 32_768,
    providerMaxOutputTokens: 8_192,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
  {
    id: 'openai-gpt-4.1',
    provider: 'openai-compatible',
    modelPattern: /^gpt-4\.1(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/i,
    contextWindowTokens: 1_047_576,
    providerMaxOutputTokens: 32_768,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
  {
    id: 'openai-gpt-4o',
    provider: 'openai-compatible',
    modelPattern: /^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/i,
    contextWindowTokens: 128_000,
    providerMaxOutputTokens: 16_384,
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  },
];

export function resolveModelTokenLimits(
  model: Pick<ModelRuntimeConfig, 'provider' | 'modelName'>,
  env: NodeJS.ProcessEnv
): ResolvedModelTokenLimits {
  const profile = MODEL_TOKEN_PROFILES.find(candidate => (
    candidate.provider === model.provider
    && candidate.modelPattern.test(model.modelName)
  ));
  const contextWindowTokens = positiveIntegerEnv(
    env,
    'MODEL_CONTEXT_WINDOW_TOKENS'
  ) ?? profile?.contextWindowTokens;
  if (!contextWindowTokens) {
    throw new Error(
      `No token profile is registered for ${model.provider}/${model.modelName}. `
      + 'Set MODEL_CONTEXT_WINDOW_TOKENS or add the model to MODEL_TOKEN_PROFILES.'
    );
  }

  const outputTokenLimit = positiveIntegerEnv(
    env,
    'MODEL_OUTPUT_TOKEN_LIMIT'
  ) ?? profile?.outputTokenLimit ?? DEFAULT_OUTPUT_TOKEN_LIMIT;
  if (
    profile?.providerMaxOutputTokens
    && outputTokenLimit > profile.providerMaxOutputTokens
  ) {
    throw new RangeError(
      `MODEL_OUTPUT_TOKEN_LIMIT ${outputTokenLimit} exceeds the provider limit `
      + `${profile.providerMaxOutputTokens} for ${model.modelName}.`
    );
  }
  if (outputTokenLimit >= contextWindowTokens) {
    throw new RangeError(
      `Output token limit ${outputTokenLimit} must be smaller than context window `
      + `${contextWindowTokens}.`
    );
  }

  const maximumInputTokens = contextWindowTokens - outputTokenLimit;
  const inputTokenLimit = positiveIntegerEnv(
    env,
    'MODEL_INPUT_TOKEN_LIMIT'
  ) ?? maximumInputTokens;
  if (inputTokenLimit > maximumInputTokens) {
    throw new RangeError(
      `MODEL_INPUT_TOKEN_LIMIT ${inputTokenLimit} leaves fewer than `
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

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}
