import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isToolMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from '../src/config/runtime-config.js';
import type { RuntimeToolContext } from '../src/runtime/execution/tool-executor.js';
import { ManagedProcessManager } from '../src/tools/process/managed-process-manager.js';
import { createManagedProcessTools } from '../src/tools/process/process-tools.js';

describe('managed process tool contract', () => {
  const roots: string[] = [];
  const managers: ManagedProcessManager[] = [];

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      await manager.stopSessionProcesses('session_process').catch(() => undefined);
      manager.shutdown();
    }
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('starts a CLI-port server, reads logs by exact processId, and stops it', async () => {
    const sandboxRoot = await temporarySandbox();
    const workspace = join(
      sandboxRoot,
      'sessions',
      'session_process',
      'workspace',
      'app'
    );
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'server.mjs'), [
      "import { createServer } from 'node:http';",
      "const value = name => process.argv[process.argv.indexOf(name) + 1];",
      "const host = value('--host');",
      "const port = Number(value('--port'));",
      "createServer((_request, response) => response.end('ready')).listen(port, host, () => {",
      "  console.log(`listening:${host}:${port}`);",
      '});',
    ].join('\n'));
    const manager = trackedManager(new ManagedProcessManager(
      undefined,
      undefined,
      sandboxRoot,
      testToolsConfig()
    ));
    await manager.start();
    const tools = createManagedProcessTools(manager, testToolsConfig().managedProcesses);

    const started = await invoke(tools, 'start_process', {
      name: 'test-server',
      cwd: 'app',
      command: 'node server.mjs --host {HOST} --port {PORT}',
      port: 'auto',
    }, toolContext(sandboxRoot, 'tool_call_start')) as {
      id: string;
      status: string;
      url: string;
    };

    expect(started).toMatchObject({
      id: expect.stringMatching(/^process_[a-f0-9]{32}$/),
      status: 'running',
    });
    await expect(fetch(started.url).then(response => response.text())).resolves.toBe('ready');
    await expect(invoke(tools, 'read_process_logs', {
      processId: started.id,
    }, toolContext(sandboxRoot, 'tool_call_logs'))).resolves.toMatchObject({
      processId: started.id,
      logs: expect.stringContaining('listening:127.0.0.1:'),
    });
    await expect(invoke(tools, 'stop_process', {
      processId: started.id,
    }, toolContext(sandboxRoot, 'tool_call_stop'))).resolves.toMatchObject({
      id: started.id,
      status: 'stopped',
    });
  });

  it('rejects a human-readable process name at the tool schema boundary', async () => {
    const sandboxRoot = await temporarySandbox();
    const manager = trackedManager(new ManagedProcessManager(
      undefined,
      undefined,
      sandboxRoot,
      testToolsConfig()
    ));
    await manager.start();
    const tools = createManagedProcessTools(manager, testToolsConfig().managedProcesses);
    const logs = tools.find(item => item.tool.name === 'read_process_logs');
    const readLogs = vi.spyOn(manager, 'readLogs');

    expect(logs?.tool.description).toContain('exact processId');
    expect(logs?.tool.description).toContain('Never pass the human-readable name');
    await expect(invoke(tools, 'read_process_logs', {
      processId: 'todo-dev-server',
    }, toolContext(sandboxRoot, 'tool_call_invalid'))).rejects.toThrow();
    expect(readLogs).not.toHaveBeenCalled();
  });

  async function temporarySandbox(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agent-process-tools-'));
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
  config.managedProcesses.portRangeStart = 5_100;
  config.managedProcesses.portRangeEnd = 5_199;
  return config;
}

function toolContext(sandboxRoot: string, toolCallId: string): RuntimeToolContext {
  return {
    sandboxRoot,
    sessionId: 'session_process',
    taskId: 'task_process',
    taskRunId: 'task_run_process',
    toolCallId,
    modelToolCallId: `model_${toolCallId}`,
    idempotencyKey: `idempotency_${toolCallId}`,
  };
}

async function invoke(
  tools: ReturnType<typeof createManagedProcessTools>,
  name: string,
  args: Record<string, unknown>,
  context: RuntimeToolContext
): Promise<unknown> {
  const runtimeTool = tools.find(item => item.tool.name === name);
  if (!runtimeTool) throw new Error(`Missing managed process tool: ${name}`);
  const output = await runtimeTool.tool.invoke({
    type: 'tool_call',
    id: context.modelToolCallId,
    name,
    args,
  }, {
    configurable: { agentRuntimeContext: context },
  });
  if (!isToolMessage(output)) throw new Error(`${name} did not return a ToolMessage.`);
  return output.artifact;
}
