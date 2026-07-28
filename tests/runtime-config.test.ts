import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';

describe('runtime configuration', () => {
  it('loads bundled JSON policy, secrets, and deployment overrides once', () => {
    const config = loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      DASHSCOPE_API_KEY: 'test-secret',
      AGENT_RUNTIME_WORKER_ID: 'worker_test',
      AGENT_SERVER_PORT: '3100',
      AGENT_SERVER_BODY_LIMIT_BYTES: '524288',
      AGENT_SERVER_AUTH_TOKEN: 'test-runtime-auth-token-32-characters',
      AGENT_SERVER_ENABLE_DEBUG_ENDPOINTS: 'true',
      AGENT_SERVER_TOOL_CAPABILITIES: 'filesystem,shell',
      TASK_OWNERSHIP_TIMEOUT_MS: '45000',
      TASK_OWNERSHIP_REFRESH_MS: '15000',
      AGENT_RUNTIME_ALLOW_PROXY_FAKE_IPS: 'true',
      AGENT_BROWSER_MAX_RESPONSE_BYTES: '262144',
      AWS_ACCESS_KEY_ID: 'aws-access-key',
      GITHUB_TOKEN: 'github-token',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      PATH: '/test/bin',
    } });

    expect(config).toMatchObject({
      workerId: 'worker_test',
      server: {
        port: 3_100,
        bodyLimitBytes: 524_288,
        authToken: 'test-runtime-auth-token-32-characters',
        debugEndpointsEnabled: true,
        toolCapabilities: ['filesystem', 'shell'],
      },
      postgres: { url: 'postgres://runtime' },
      model: { provider: 'dashscope', apiKey: 'test-secret', modelName: 'qwen3.7-max' },
      modelTokenLimits: {
        contextWindowTokens: 1_000_000,
        outputTokenLimit: 4_096,
        inputTokenLimit: 995_904,
      },
      execution: { ownershipTimeoutMs: 45_000, ownershipRefreshMs: 15_000 },
      tools: {
        browser: {
          allowProxyFakeIps: true,
          maximumResponseBytes: 262_144,
        },
      },
    });
    expect(config.tools.hostEnvironment).toEqual({ PATH: '/test/bin' });
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

  it('adds a stable process-boot identity to automatic worker ids', () => {
    const first = loadRuntimeConfig({ env: { DATABASE_URL: 'postgres://runtime' } });
    const second = loadRuntimeConfig({ env: { DATABASE_URL: 'postgres://runtime' } });

    expect(first.workerId).toBe(second.workerId);
    expect(first.workerId).toMatch(
      new RegExp(`^worker_${process.pid}_[0-9a-f]{8}-[0-9a-f-]{27}$`)
    );
  });

  it('rejects inconsistent execution ownership timing', () => {
    expect(() => loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      TASK_OWNERSHIP_TIMEOUT_MS: '10000',
      TASK_OWNERSHIP_REFRESH_MS: '10000',
    } })).toThrow('ownershipRefreshMs must be shorter');
  });

  it('rejects configured HTTP bearer tokens shorter than 32 characters', () => {
    expect(() => loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      AGENT_SERVER_AUTH_TOKEN: 'too-short',
    } })).toThrow('at least 32 characters');
  });

  it('rejects unknown standalone HTTP tool capabilities', () => {
    expect(() => loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      AGENT_SERVER_TOOL_CAPABILITIES: 'filesystem,host-root',
    } })).toThrow('Unsupported HTTP tool capability');
  });

  it('inherits only explicitly allowed non-sensitive host environment keys', () => {
    const config = loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      AGENT_TOOL_INHERITED_ENV_KEYS: 'PATH,JAVA_HOME,LANG',
      PATH: '/test/bin',
      JAVA_HOME: '/test/java',
      LANG: 'en_US.UTF-8',
      AWS_ACCESS_KEY_ID: 'aws-access-key',
    } });
    expect(config.tools.hostEnvironment).toEqual({
      PATH: '/test/bin',
      JAVA_HOME: '/test/java',
      LANG: 'en_US.UTF-8',
    });
  });

  it('rejects sensitive keys in the inherited environment allowlist', () => {
    expect(() => loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      AGENT_TOOL_INHERITED_ENV_KEYS: 'PATH,GITHUB_TOKEN',
    } })).toThrow('Sensitive environment key cannot be inherited');
  });
});
