import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  RuntimeToolExecutionError,
  type RuntimeTool,
  type RuntimeToolContext,
} from '../runtime/tool-executor.js';
import { workspaceRoot } from './sandbox.js';
import {
  jsonToolOutput,
  numberArgument,
  runtimeContext,
  stringArgument,
} from './tool-utils.js';
import { buildWorkspaceProcessEnv, stringRecord } from './process-environment.js';

const SHELL_PATH = '/bin/zsh';
const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 1_800_000;
const MAX_OUTPUT_BYTES = 32 * 1024;
const TERMINATION_GRACE_MS = 1_000;

export interface ShellExecutionResult {
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

export function createShellTools(): RuntimeTool[] {
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
          maxLength: 20_000,
          description: 'Shell command to execute with /bin/zsh. It must not require interactive input.',
        },
        cwd: {
          type: 'string',
          default: '.',
          description: 'Existing directory in which to run the command. Relative paths start at the Session workspace; absolute paths are allowed.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
          default: DEFAULT_TIMEOUT_MS,
          description: `Execution timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
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
      const timeoutMs = normalizeTimeout(numberArgument(args, 'timeoutMs', DEFAULT_TIMEOUT_MS));
      const env = stringRecord(args.env, 'env');
      const result = await executeHostShell({
        context: runtimeContext(config),
        command,
        cwd,
        timeoutMs,
        env,
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
}): Promise<ShellExecutionResult> {
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
  const timeoutMs = normalizeTimeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  const child = spawn(SHELL_PATH, [
    '-f',
    '-c',
    input.command,
  ], {
    cwd,
    env: buildWorkspaceProcessEnv(input.env),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = captureOutput(child.stdout);
  const stderr = captureOutput(child.stderr);
  const completion = await waitForChild(child, timeoutMs, input.context.signal);
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


function normalizeTimeout(value: number): number {
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

function captureOutput(stream: NodeJS.ReadableStream): {
  text(): string;
  truncated(): boolean;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let wasTruncated = false;
  stream.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = MAX_OUTPUT_BYTES - bytes;
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
    }, TERMINATION_GRACE_MS);
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
