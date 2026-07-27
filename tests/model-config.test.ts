import { describe, expect, it } from 'vitest';
import {
  DASHSCOPE_OPENAI_BASE_URL,
  loadRuntimeConfig,
} from '../src/config/runtime-config.js';

describe('loadRuntimeConfig model resolution', () => {
  it('uses DashScope defaults and gives its key precedence', () => {
    const config = loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      DASHSCOPE_API_KEY: 'dash-key',
      OPENAI_API_KEY: 'openai-key',
    } });
    expect(config.model).toMatchObject({
      apiKey: 'dash-key',
      baseURL: DASHSCOPE_OPENAI_BASE_URL,
      modelName: 'qwen3.7-max',
      provider: 'dashscope',
    });
  });

  it('allows explicit compatible endpoint and model overrides', () => {
    const config = loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      DASHSCOPE_API_KEY: 'dash-key',
      OPENAI_BASE_URL: 'https://workspace.example/v1',
      OPENAI_MODEL: 'qwen-custom',
      MODEL_CONTEXT_WINDOW_TOKENS: '64000',
    } });
    expect(config.model).toMatchObject({
      baseURL: 'https://workspace.example/v1',
      modelName: 'qwen-custom',
      provider: 'dashscope',
    });
  });

  it('selects the OpenAI-compatible provider when only its key is supplied', () => {
    const config = loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'gpt-4.1-mini',
    } });
    expect(config.model).toMatchObject({
      apiKey: 'openai-key',
      modelName: 'gpt-4.1-mini',
      provider: 'openai-compatible',
    });
  });
});
