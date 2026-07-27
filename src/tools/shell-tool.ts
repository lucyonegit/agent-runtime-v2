import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from '../config/runtime-config.js';
import {
  RuntimeToolExecutionError,
  type RuntimeTool,
  type RuntimeToolContext,
} from '../runtime/execution/tool-executor.js';
import { workspaceRoot } from './helpers/workspace-path.helper.js';
import {
  jsonToolOutput,
  numberArgument,
  runtimeContext,
  stringArgument,
} from './helpers/tool-input.helper.js';
import {
  buildWorkspaceProcessEnv,
  stringRecord,
} from './helpers/process-environment.helper.js';

interface ShellExecutionResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

const SHELL_TOOL_LIMITS = {
  minimumTimeoutMs: 100,
  maximumOutputBytes: 32 * 1_024,
  terminationGraceMs: 1_000,
  maximumCommandCharacters: 20_000,
} as const;

type ShellToolConfig = ToolsConfig['shell'] & typeof SHELL_TOOL_LIMITS;

export function createShellTools(
  toolsConfig: ToolsConfig = DEFAULT_TOOLS_CONFIG
): RuntimeTool[] {
  const shell = resolveShellToolConfig(toolsConfig.shell);
  const runShell = new DynamicStructuredTool({
    name: 'run_shell',
    description: [
      'Run a finite, non-interactive command with the same host permissions, network access, and filesystem access as the Runtime process.',
      'Use it for dependency installation, project scaffolding, builds, tests, scripts, and host filesystem operations.',
      'Do not use it for persistent servers such as npm start, npm run dev, vite, or next dev; use start_process instead.',
      'Relative cwd values start from the current Session workspace; absolute paths and parent-directory paths are allowed.',
      'Runtime-only HOST, PORT, database, and model-provider variables are removed; pass child variables explicitly with env.',
      'Commands are subject to the requested timeout, output limits, and Job cancellation.',
      'Never print or return secrets from the inherited environment.',
    ].join(' '),
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          minLength: 1,
          maxLength: shell.maximumCommandCharacters,
          description: `Shell command to execute with ${shell.executable}. It must not require interactive input.`,
        },
        cwd: {
          type: 'string',
          default: '.',
          description: 'Existing directory in which to run the command. Relative paths start at the Session workspace; absolute paths are allowed.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: shell.minimumTimeoutMs,
          maximum: shell.maximumTimeoutMs,
          default: shell.defaultTimeoutMs,
          description: `Execution timeout in milliseconds. Defaults to ${shell.defaultTimeoutMs}.`,
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Environment variables explicitly supplied to the command.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (input, _runManager, config) => {
      const args = input as Record<string, unknown>;
      const command = stringArgument(args, 'command');
      if (!command.trim()) throw new Error('Shell command is required.');
      const cwd = stringArgument(args, 'cwd', '.').trim() || '.';
      const timeoutMs = normalizeTimeout(
        numberArgument(args, 'timeoutMs', shell.defaultTimeoutMs),
        shell
      );
      const env = stringRecord(args.env, 'env');
      const result = await executeHostShell({
        context: runtimeContext(config),
        command,
        cwd,
        timeoutMs,
        env,
        toolsConfig,
      });
      assertSuccessfulShellResult(result);
      return jsonToolOutput(result);
    },
  });

  return [{
    tool: runShell,
    sideEffectLevel: 'side_effecting',
    exclusive: true,
    requiresFreshContext: true,
  }];
}

export async function executeHostShell(input: {
  context: RuntimeToolContext;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  toolsConfig?: ToolsConfig;
}): Promise<ShellExecutionResult> {
  const toolsConfig = input.toolsConfig ?? DEFAULT_TOOLS_CONFIG;
  const shell = resolveShellToolConfig(toolsConfig.shell);
  const root = await realpath(await workspaceRoot(input.context));
  const cwdInput = input.cwd?.trim() || '.';
  const cwd = await realpath(isAbsolute(cwdInput) ? cwdInput : resolve(root, cwdInput));
  if (!(await lstat(cwd)).isDirectory()) {
    throw new Error(`Shell cwd is not a directory: ${cwdInput}`);
  }
  const relativeCwd = relative(root, cwd);
  const logicalCwd = relativeCwd === '..' || relativeCwd.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ? cwd
    : relativeCwd || '.';
  const timeoutMs = normalizeTimeout(input.timeoutMs ?? shell.defaultTimeoutMs, shell);
  const startedAt = Date.now();
  const child = spawn(shell.executable, [
    '-f',
    '-c',
    input.command,
  ], {
    cwd,
    env: buildWorkspaceProcessEnv(input.env, toolsConfig.hostEnvironment),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = captureOutput(child.stdout, shell.maximumOutputBytes);
  const stderr = captureOutput(child.stderr, shell.maximumOutputBytes);
  const completion = await waitForChild(
    child,
    timeoutMs,
    shell.terminationGraceMs,
    input.context.signal
  );
  return {
    command: input.command,
    cwd: logicalCwd,
    exitCode: completion.exitCode,
    signal: completion.signal,
    timedOut: completion.timedOut,
    durationMs: Date.now() - startedAt,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutTruncated: stdout.truncated(),
    stderrTruncated: stderr.truncated(),
  };
}

export function assertSuccessfulShellResult(result: ShellExecutionResult): void {
  if (result.timedOut) {
    throw new RuntimeToolExecutionError(
      'shell_timeout',
      `Shell command exceeded its ${result.durationMs}ms execution window and was terminated.`,
      result
    );
  }
  if (result.exitCode !== 0) {
    const diagnostic = (result.stderr.trim() || result.stdout.trim()).slice(0, 1_000);
    throw new RuntimeToolExecutionError(
      'shell_command_failed',
      `Shell command exited with code ${result.exitCode ?? 'unknown'}${diagnostic ? `: ${diagnostic}` : '.'}`,
      result
    );
  }
}


function normalizeTimeout(
  value: number,
  config: ShellToolConfig
): number {
  return Math.min(
    config.maximumTimeoutMs,
    Math.max(config.minimumTimeoutMs, Math.round(value))
  );
}

function resolveShellToolConfig(
  config: ToolsConfig['shell']
): ShellToolConfig {
  return {
    ...config,
    ...SHELL_TOOL_LIMITS,
  };
}

function captureOutput(stream: NodeJS.ReadableStream, maximumBytes: number): {
  text(): string;
  truncated(): boolean;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let wasTruncated = false;
  stream.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = maximumBytes - bytes;
    if (remaining <= 0) {
      wasTruncated = true;
      return;
    }
    if (chunk.byteLength > remaining) {
      chunks.push(chunk.subarray(0, remaining));
      bytes += remaining;
      wasTruncated = true;
      return;
    }
    chunks.push(chunk);
    bytes += chunk.byteLength;
  });
  return {
    text: () => Buffer.concat(chunks, bytes).toString('utf8'),
    truncated: () => wasTruncated,
  };
}

async function waitForChild(
  child: ChildProcess,
  timeoutMs: number,
  terminationGraceMs: number,
  signal?: AbortSignal
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
  let timedOut = false;
  let aborted = signal?.aborted ?? false;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const terminate = (): void => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    forceKillTimer = setTimeout(() => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, terminationGraceMs);
    forceKillTimer.unref();
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  timeout.unref();
  const onAbort = (): void => {
    aborted = true;
    terminate();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (aborted) terminate();

  try {
    const completion = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, childSignal) => resolve({
        exitCode,
        signal: childSignal,
      }));
    });
    if (aborted) throw abortError();
    return { ...completion, timedOut };
  } finally {
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function abortError(): Error {
  const error = new Error('Shell execution was aborted.');
  error.name = 'AbortError';
  return error;
}
