import { describe, expect, it } from 'vitest';
import {
  resolveModelTokenLimits,
} from '../src/config/model-config.js';

describe('resolveModelTokenLimits', () => {
  it('uses the registered qwen-max limits instead of a global 128K guess', () => {
    expect(resolveModelTokenLimits({
      provider: 'dashscope',
      modelName: 'qwen-max',
      tokens: tokenOverrides(),
    })).toEqual({
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
      tokens: tokenOverrides(),
    })).toMatchObject({
      profileId: 'dashscope-qwen-plus',
      contextWindowTokens: 1_000_000,
      outputTokenLimit: 4_096,
      inputTokenLimit: 995_904,
    });
    expect(resolveModelTokenLimits({
      provider: 'openai-compatible',
      modelName: 'gpt-4.1-mini-2025-04-14',
      tokens: tokenOverrides(),
    })).toMatchObject({
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
      tokens: {
        contextWindowTokens: 64_000,
        outputTokenLimit: 2_048,
        inputTokenLimit: 60_000,
      },
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
      tokens: tokenOverrides(),
    })).toThrow('No token profile is registered');
  });

  it('rejects limits that cannot fit inside the provider context window', () => {
    expect(() => resolveModelTokenLimits({
      provider: 'dashscope',
      modelName: 'qwen-max',
      tokens: { ...tokenOverrides(), inputTokenLimit: 30_000 },
    })).toThrow('does not reserve 4096 output tokens');
    expect(() => resolveModelTokenLimits({
      provider: 'dashscope',
      modelName: 'qwen-max',
      tokens: { ...tokenOverrides(), outputTokenLimit: 9_000 },
    })).toThrow('exceeds provider limit');
  });
});

function tokenOverrides() {
  return {
    contextWindowTokens: null,
    outputTokenLimit: null,
    inputTokenLimit: null,
  };
}
