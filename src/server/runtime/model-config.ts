export const DASHSCOPE_OPENAI_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export interface ModelRuntimeConfig {
  apiKey?: string;
  baseURL?: string;
  modelName: string;
  provider: 'dashscope' | 'openai-compatible';
}

export function resolveModelRuntimeConfig(env: NodeJS.ProcessEnv): ModelRuntimeConfig {
  if (env.DASHSCOPE_API_KEY?.trim()) {
    return {
      apiKey: env.DASHSCOPE_API_KEY,
      baseURL: env.OPENAI_BASE_URL ?? DASHSCOPE_OPENAI_BASE_URL,
      modelName: env.OPENAI_MODEL ?? 'qwen-plus',
      provider: 'dashscope',
    };
  }
  return {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    modelName: env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    provider: 'openai-compatible',
  };
}
