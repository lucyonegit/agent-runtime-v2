import { describe, expect, it } from 'vitest';
import {
  resolveModelTokenLimits,
} from '../src/server/runtime/model-token-limits.js';

describe('resolveModelTokenLimits', () => {
  it('uses the registered qwen-max limits instead of a global 128K guess', () => {
    expect(resolveModelTokenLimits({
      provider: 'dashscope',
      modelName: 'qwen-max',
    }, {})).toEqual({
      profileId: 'dashscope-qwen-max',
      contextWindowTokens: 32_768,
      outputTokenLimit: 4_096,
      inputTokenLimit: 28_672,
    });
  });

  it('resolves aliases and snapshots through the same model family profile', () => {
    expect(resolveModelTokenLimits({
      provider: 'dashscope',
      modelName: 'qwen-plus-2025-12-01',
    }, {})).toMatchObject({
      profileId: 'dashscope-qwen-plus',
      contextWindowTokens: 1_000_000,
      outputTokenLimit: 4_096,
      inputTokenLimit: 995_904,
    });
    expect(resolveModelTokenLimits({
      provider: 'openai-compatible',
      modelName: 'gpt-4.1-mini-2025-04-14',
    }, {})).toMatchObject({
      profileId: 'openai-gpt-4.1',
      contextWindowTokens: 1_047_576,
      outputTokenLimit: 4_096,
      inputTokenLimit: 1_043_480,
    });
  });

  it('allows deployment overrides while preserving context arithmetic', () => {
    expect(resolveModelTokenLimits({
      provider: 'openai-compatible',
      modelName: 'private-model',
    }, {
      MODEL_CONTEXT_WINDOW_TOKENS: '64000',
      MODEL_OUTPUT_TOKEN_LIMIT: '2048',
      MODEL_INPUT_TOKEN_LIMIT: '60000',
    })).toEqual({
      contextWindowTokens: 64_000,
      outputTokenLimit: 2_048,
      inputTokenLimit: 60_000,
    });
  });

  it('fails fast for an unknown model without an explicit context window', () => {
    expect(() => resolveModelTokenLimits({
      provider: 'openai-compatible',
      modelName: 'private-model',
    }, {})).toThrow('No token profile is registered');
  });

  it('rejects limits that cannot fit inside the provider context window', () => {
    expect(() => resolveModelTokenLimits({
      provider: 'dashscope',
      modelName: 'qwen-max',
    }, {
      MODEL_INPUT_TOKEN_LIMIT: '30000',
    })).toThrow('leaves fewer than 4096 output tokens');
    expect(() => resolveModelTokenLimits({
      provider: 'dashscope',
      modelName: 'qwen-max',
    }, {
      MODEL_OUTPUT_TOKEN_LIMIT: '9000',
    })).toThrow('exceeds the provider limit');
  });
});
