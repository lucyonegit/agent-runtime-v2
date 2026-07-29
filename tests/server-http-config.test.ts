import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { DEFAULT_SERVER_CONFIG, loadRuntimeConfig } from '../src/config/runtime-config.js';
import { AgentDebugController } from '../src/server/http/agent-debug.controller.js';
import { AgentController } from '../src/server/http/agent.controller.js';
import { AgentHttpModule } from '../src/server/http/agent-http.module.js';
import { AgentManagedProcessController } from '../src/server/http/agent-managed-process.controller.js';
import { restrictHttpToolCapabilities } from '../src/server/http/http-tool-capabilities.js';
import {
  requireRuntimeHttpAuthToken,
  RuntimeHttpAuthGuard,
} from '../src/server/http/runtime-http-auth.guard.js';
import { buildWorkspaceProcessEnv } from '../src/tools/process/helpers/process-environment.helper.js';

describe('Agent HTTP CORS configuration', () => {
  it('allows the browser methods used by the Session API', () => {
    expect(DEFAULT_SERVER_CONFIG.cors.methods).toEqual([
      'GET',
      'HEAD',
      'POST',
      'DELETE',
      'OPTIONS',
    ]);
    expect(DEFAULT_SERVER_CONFIG.cors.origin).toEqual([
      'http://127.0.0.1:5174',
      'http://localhost:5174',
    ]);
    expect(DEFAULT_SERVER_CONFIG.cors.credentials).toBe(false);
    expect(DEFAULT_SERVER_CONFIG.cors.allowedHeaders).toContain('authorization');
    expect(DEFAULT_SERVER_CONFIG.cors.allowedHeaders).toContain('content-type');
    expect(DEFAULT_SERVER_CONFIG.bodyLimitBytes).toBe(1_048_576);
    expect(DEFAULT_SERVER_CONFIG.debugEndpointsEnabled).toBe(false);
    expect(DEFAULT_SERVER_CONFIG.toolCapabilities).toEqual([
      'artifacts',
      'filesystem',
      'browser',
    ]);
  });

  it('does not register Debug Context routes unless explicitly enabled', () => {
    expect(httpModule(false).controllers).toEqual([AgentController]);
    expect(httpModule(true).controllers).toEqual([
      AgentController,
      AgentDebugController,
    ]);
  });

  it('keeps host process tools out of HTTP and permits public-web reads by default', () => {
    const config = loadRuntimeConfig({ env: { DATABASE_URL: 'postgres://runtime' } });
    const restricted = restrictHttpToolCapabilities(config);

    expect(config.tools.enabled).toMatchObject({
      shell: true,
      managedProcesses: true,
      browser: true,
    });
    expect(restricted.tools.enabled).toEqual({
      hitl: true,
      basic: true,
      artifacts: true,
      filesystem: true,
      shell: false,
      managedProcesses: false,
      browser: true,
    });
    expect(httpModule(false, false).controllers).not.toContain(
      AgentManagedProcessController
    );
    expect(httpModule(false, true).controllers).toContain(
      AgentManagedProcessController
    );
  });

  it('enables only explicitly granted HTTP tool capabilities', () => {
    const config = loadRuntimeConfig({ env: {
      DATABASE_URL: 'postgres://runtime',
      AGENT_SERVER_TOOL_CAPABILITIES: 'shell,browser',
    } });

    expect(restrictHttpToolCapabilities(config).tools.enabled).toMatchObject({
      artifacts: false,
      filesystem: false,
      shell: true,
      managedProcesses: false,
      browser: true,
    });
  });

  it('requires a long bearer token before the HTTP server starts', () => {
    expect(() => requireRuntimeHttpAuthToken('')).toThrow('AGENT_SERVER_AUTH_TOKEN');
    expect(requireRuntimeHttpAuthToken('test-runtime-auth-token-32-characters')).toBe(
      'test-runtime-auth-token-32-characters'
    );
  });

  it('accepts only an exact bearer token', () => {
    const token = 'test-runtime-auth-token-32-characters';
    const guard = new RuntimeHttpAuthGuard(token);
    expect(guard.canActivate(context(`Bearer ${token}`))).toBe(true);
    expect(() => guard.canActivate(context(`Bearer ${token}-wrong`))).toThrow('bearer token');
    expect(() => guard.canActivate(context(undefined))).toThrow('bearer token');
  });

  it('does not expose the HTTP bearer token to tool child processes', () => {
    expect(buildWorkspaceProcessEnv({}, {
      PATH: '/test/bin',
      AGENT_SERVER_AUTH_TOKEN: 'test-runtime-auth-token-32-characters',
    }, ['PATH', 'AGENT_SERVER_AUTH_TOKEN'])).toEqual({ PATH: '/test/bin' });
  });
});

function context(authorization: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

function httpModule(
  debugEndpointsEnabled: boolean,
  managedProcessEndpointsEnabled = false
) {
  return AgentHttpModule.forRoot(
    null as never,
    null as never,
    null as never,
    null as never,
    'test-runtime-auth-token-32-characters',
    debugEndpointsEnabled,
    managedProcessEndpointsEnabled
  );
}
