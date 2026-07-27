export const DASHSCOPE_OPENAI_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

export type ModelProvider = 'dashscope' | 'openai-compatible';

export interface ModelTokenOverrides {
  contextWindowTokens: number | null;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
}

export interface ModelTokenSettings {
  provider: ModelProvider;
  modelName: string;
  tokens: ModelTokenOverrides;
}

export interface ResolvedModelTokenLimits {
  profileId?: string;
  contextWindowTokens: number;
  outputTokenLimit: number;
  inputTokenLimit: number;
}

export interface ModelTokenProfile {
  id: string;
  provider: ModelProvider;
  modelPattern: RegExp;
  contextWindowTokens: number;
  providerMaxOutputTokens?: number;
  outputTokenLimit: number;
}

const DEFAULT_OUTPUT_TOKEN_LIMIT = 4_096;

export const MODEL_TOKEN_PROFILES: readonly ModelTokenProfile[] = [
  profile('dashscope-qwen-3.7', 'dashscope', /^qwen3\.7-(?:max|plus)(?:-|$)/i, 1_000_000, 65_536),
  profile('dashscope-qwen-3.6-plus-flash', 'dashscope', /^qwen3\.6-(?:plus|flash)(?:-|$)/i, 1_000_000, 65_536),
  profile('dashscope-qwen-3.6-max', 'dashscope', /^qwen3\.6-max(?:-|$)/i, 262_144, 65_536),
  profile('dashscope-qwen-3.5-plus-flash', 'dashscope', /^qwen3\.5-(?:plus|flash)(?:-|$)/i, 1_000_000, 65_536),
  profile('dashscope-qwen-3-max', 'dashscope', /^qwen3-max(?:-|$)/i, 262_144, 65_536),
  profile('dashscope-qwen-3-coder-long', 'dashscope', /^qwen3-coder-(?:plus|flash)(?:-|$)/i, 1_000_000, 65_536),
  profile(
    'dashscope-qwen-3-coder-256k',
    'dashscope',
    /^qwen3-coder-(?:next|480b-a35b-instruct|30b-a3b-instruct)(?:-|$)/i,
    262_144,
    65_536
  ),
  profile('dashscope-qwen-plus', 'dashscope', /^qwen-plus(?:-\d{4}-\d{2}-\d{2})?$/i, 1_000_000),
  profile('dashscope-qwen-max', 'dashscope', /^qwen-max(?:-\d{4}-\d{2}-\d{2})?$/i, 32_768, 8_192),
  profile(
    'openai-gpt-4.1',
    'openai-compatible',
    /^gpt-4\.1(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/i,
    1_047_576,
    32_768
  ),
  profile(
    'openai-gpt-4o',
    'openai-compatible',
    /^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/i,
    128_000,
    16_384
  ),
];

export function resolveModelTokenLimits(
  model: ModelTokenSettings
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

function profile(
  id: string,
  provider: ModelProvider,
  modelPattern: RegExp,
  contextWindowTokens: number,
  providerMaxOutputTokens?: number
): ModelTokenProfile {
  return {
    id,
    provider,
    modelPattern,
    contextWindowTokens,
    ...(providerMaxOutputTokens ? { providerMaxOutputTokens } : {}),
    outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  };
}
