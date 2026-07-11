import { describe, expect, it } from 'vitest';
import {
  DASHSCOPE_OPENAI_BASE_URL,
  resolveModelRuntimeConfig,
} from '../src/server/runtime/model-config.js';

describe('resolveModelRuntimeConfig', () => {
  it('uses DashScope defaults and gives its key precedence', () => {
    expect(resolveModelRuntimeConfig({
      DASHSCOPE_API_KEY: 'dash-key',
      OPENAI_API_KEY: 'openai-key',
    })).toEqual({
      apiKey: 'dash-key',
      baseURL: DASHSCOPE_OPENAI_BASE_URL,
      modelName: 'qwen-plus',
      provider: 'dashscope',
    });
  });

  it('allows explicit compatible endpoint and model overrides', () => {
    expect(resolveModelRuntimeConfig({
      DASHSCOPE_API_KEY: 'dash-key',
      OPENAI_BASE_URL: 'https://workspace.example/v1',
      OPENAI_MODEL: 'qwen-custom',
    })).toMatchObject({
      baseURL: 'https://workspace.example/v1',
      modelName: 'qwen-custom',
      provider: 'dashscope',
    });
  });

  it('preserves the OpenAI-compatible fallback and missing-key startup', () => {
    expect(resolveModelRuntimeConfig({ OPENAI_API_KEY: 'openai-key' })).toEqual({
      apiKey: 'openai-key',
      baseURL: undefined,
      modelName: 'gpt-4.1-mini',
      provider: 'openai-compatible',
    });
    expect(resolveModelRuntimeConfig({})).toMatchObject({
      apiKey: undefined,
      provider: 'openai-compatible',
    });
  });
});
