import type { ModelProvider } from './model-config.js';

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
