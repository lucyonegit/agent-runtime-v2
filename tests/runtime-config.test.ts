import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';

describe('runtime configuration', () => {
  it('loads bundled JSON policy, secrets, and deployment overrides once', () => {
    const config = loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      DASHSCOPE_API_KEY: 'test-secret',
      AGENT_RUNTIME_WORKER_ID: 'worker_test',
      AGENT_SERVER_PORT: '3100',
      TASK_OWNERSHIP_TIMEOUT_MS: '45000',
      TASK_OWNERSHIP_REFRESH_MS: '15000',
      AGENT_RUNTIME_ALLOW_PROXY_FAKE_IPS: 'true',
      PATH: '/test/bin',
    } });

    expect(config).toMatchObject({
      workerId: 'worker_test',
      server: { port: 3_100 },
      postgres: { url: 'postgres://runtime' },
      model: { provider: 'dashscope', apiKey: 'test-secret', modelName: 'qwen3.7-max' },
      modelTokenLimits: {
        contextWindowTokens: 1_000_000,
        outputTokenLimit: 4_096,
        inputTokenLimit: 995_904,
      },
      execution: { ownershipTimeoutMs: 45_000, ownershipRefreshMs: 15_000 },
      tools: { browser: { allowProxyFakeIps: true } },
    });
    expect(config.tools.hostEnvironment).toMatchObject({
      PATH: '/test/bin',
      DASHSCOPE_API_KEY: 'test-secret',
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('switches provider defaults without leaking the DashScope endpoint', () => {
    const config = loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      OPENAI_API_KEY: 'openai-secret',
      OPENAI_MODEL: 'gpt-4.1-mini',
    } });
    expect(config.model).toMatchObject({
      provider: 'openai-compatible',
      apiKey: 'openai-secret',
      baseURL: '',
      modelName: 'gpt-4.1-mini',
    });
  });

  it('rejects inconsistent execution ownership timing', () => {
    expect(() => loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      TASK_OWNERSHIP_TIMEOUT_MS: '10000',
      TASK_OWNERSHIP_REFRESH_MS: '10000',
    } })).toThrow('ownershipRefreshMs must be shorter');
  });
});
