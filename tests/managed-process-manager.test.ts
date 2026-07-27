import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRealtimeEvent } from '../src/domain/index.js';
import { ManagedProcessManager } from '../src/tools/process/managed-process-manager.js';
import type { RuntimeToolContext } from '../src/runtime/execution/tool-executor.js';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from '../src/config/runtime-config.js';

describe('ManagedProcessManager', () => {
  const roots: string[] = [];
  const managers: ManagedProcessManager[] = [];

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      await manager.stopSessionProcesses('session_process').catch(() => undefined);
      manager.shutdown();
    }
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('allocates a clean port, waits for readiness, captures logs, and stops only its marked process group', async () => {
    const sandboxRoot = await temporarySandbox();
    const events: AgentRealtimeEvent[] = [];
    const manager = trackedManager(new ManagedProcessManager(
      { publish: event => { events.push(event); } },
      { nowMs: () => Date.now() },
      sandboxRoot,
      testToolsConfig()
    ));
    await manager.start();
    const context = toolContext(sandboxRoot);
    const started = await manager.startProcess({
      context,
      name: 'test-server',
      command: [
        `node -e "const http=require('http');`,
        `console.log('runtime-port='+(process.env.AGENT_SERVER_PORT||'hidden'));`,
        `http.createServer((q,r)=>r.end('ready')).listen(Number(process.env.PORT),'127.0.0.1')"`,
      ].join(' '),
      port: 'auto',
      startupTimeoutMs: 10_000,
    });

    expect(started).toMatchObject({ status: 'running', host: '127.0.0.1' });
    await expect(fetch(started.url).then(response => response.text())).resolves.toBe('ready');
    await expect(manager.readLogs(started.id)).resolves.toContain('runtime-port=hidden');
    await expect(manager.listSessionProcesses(context.sessionId)).resolves.toEqual([
      expect.objectContaining({ id: started.id, status: 'running' }),
    ]);
    await expect(manager.startProcess({
      context: { ...context, toolInvocationId: 'invocation_process_2', toolCallId: 'call_process_2' },
      name: 'test-server',
      command: `node -e "require('http').createServer((q,r)=>r.end('ready')).listen(Number(process.env.PORT),'127.0.0.1')"`,
      port: 'auto',
    })).rejects.toMatchObject({ code: 'managed_process_conflict' });

    const stopped = await manager.stopProcess(started.id);
    expect(stopped.status).toBe('stopped');
    expect(events.some(event => (
      event.type === 'managed_process.upserted' && event.process.status === 'running'
    ))).toBe(true);
  });

  it('reports an exit-before-ready even when the command exits with code zero', async () => {
    const sandboxRoot = await temporarySandbox();
    const manager = trackedManager(new ManagedProcessManager(
      undefined,
      undefined,
      sandboxRoot,
      testToolsConfig()
    ));
    await manager.start();

    await expect(manager.startProcess({
      context: toolContext(sandboxRoot),
      name: 'not-a-server',
      command: `node -e "console.log('Something is already running on a different port')"`,
      port: 'auto',
      startupTimeoutMs: 5_000,
    })).rejects.toMatchObject({ code: 'process_exited_before_ready' });
    await expect(manager.listSessionProcesses('session_process')).resolves.toEqual([
      expect.objectContaining({ status: 'failed', exitCode: 0 }),
    ]);
  });

  it('adopts a surviving marked process after the Runtime manager restarts', async () => {
    const sandboxRoot = await temporarySandbox();
    const firstManager = trackedManager(new ManagedProcessManager(
      undefined,
      undefined,
      sandboxRoot,
      testToolsConfig()
    ));
    await firstManager.start();
    const started = await firstManager.startProcess({
      context: toolContext(sandboxRoot),
      name: 'surviving-server',
      command: `node -e "require('http').createServer((q,r)=>r.end('adopted')).listen(Number(process.env.PORT),'127.0.0.1')"`,
      port: 'auto',
      startupTimeoutMs: 10_000,
    });
    firstManager.shutdown();

    const restartedManager = trackedManager(new ManagedProcessManager(
      undefined,
      undefined,
      sandboxRoot,
      testToolsConfig()
    ));
    await restartedManager.start();
    await expect(restartedManager.getProcess(started.id)).resolves.toMatchObject({
      id: started.id,
      pid: started.pid,
      processGroupId: started.processGroupId,
      status: 'running',
    });
    await expect(fetch(started.url).then(response => response.text())).resolves.toBe('adopted');
    await expect(restartedManager.stopProcess(started.id)).resolves.toMatchObject({ status: 'stopped' });
  });

  async function temporarySandbox(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agent-managed-process-'));
    roots.push(root);
    return root;
  }

  function trackedManager(manager: ManagedProcessManager): ManagedProcessManager {
    managers.push(manager);
    return manager;
  }
});

function testToolsConfig(): ToolsConfig {
  const config = structuredClone(DEFAULT_TOOLS_CONFIG) as ToolsConfig;
  config.hostEnvironment = { ...process.env };
  return config;
}

function toolContext(sandboxRoot: string): RuntimeToolContext {
  return {
    sandboxRoot,
    sessionId: 'session_process',
    jobId: 'job_process',
    attemptId: 'attempt_process',
    toolInvocationId: 'invocation_process',
    toolCallId: 'call_process',
    idempotencyKey: 'process_idempotency',
  };
}
