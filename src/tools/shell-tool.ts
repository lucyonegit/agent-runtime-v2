import { spawn, type ChildProcess } from 'node:child_process';
import { access, lstat, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { relative } from 'node:path';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RuntimeTool, RuntimeToolContext } from '../runtime/tool-executor.js';
import { resolveWorkspacePath, workspaceRoot } from './sandbox.js';
import {
  jsonToolOutput,
  numberArgument,
  runtimeContext,
  stringArgument,
} from './tool-utils.js';

const SHELL_PATH = '/bin/zsh';
const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
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
      'Run a non-interactive shell command inside the current session workspace.',
      'Use it to inspect, build, test, or transform files created for the user.',
      'The command has no network access, cannot read files outside the workspace and approved system tool directories,',
      'and does not inherit runtime secrets such as API keys or database credentials.',
      'Use workspace-relative paths and never place secrets in the command string.',
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
          description: 'Existing workspace-relative directory in which to run the command. Defaults to the workspace root.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
          default: DEFAULT_TIMEOUT_MS,
          description: `Execution timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
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
      const result = await executeSandboxedShell({
        context: runtimeContext(config),
        command,
        cwd,
        timeoutMs,
      });
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

export async function executeSandboxedShell(input: {
  context: RuntimeToolContext;
  command: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<ShellExecutionResult> {
  if (process.platform !== 'darwin') {
    throw new Error(`run_shell is unavailable on ${process.platform}: a supported OS sandbox is required.`);
  }
  await access(SANDBOX_EXEC_PATH, fsConstants.X_OK);
  await access(SHELL_PATH, fsConstants.X_OK);

  const root = await realpath(await workspaceRoot(input.context));
  const cwdInput = input.cwd?.trim() || '.';
  const cwd = await resolveWorkspacePath(input.context, cwdInput, { mustExist: true });
  if (!(await lstat(cwd)).isDirectory()) {
    throw new Error(`Shell cwd is not a directory: ${cwdInput}`);
  }
  const logicalCwd = relative(root, cwd) || '.';
  const timeoutMs = normalizeTimeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  const child = spawn(SANDBOX_EXEC_PATH, [
    '-p',
    darwinSandboxProfile(root),
    SHELL_PATH,
    '-f',
    '-c',
    commandWithResourceLimits(input.command),
  ], {
    cwd,
    env: shellEnvironment(root, cwd),
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

function commandWithResourceLimits(command: string): string {
  return [
    'umask 077',
    'ulimit -St 120; ulimit -Ht 120',
    'ulimit -Sf 524288; ulimit -Hf 524288',
    'ulimit -Sn 256; ulimit -Hn 256',
    'ulimit -Su 512; ulimit -Hu 512',
    command,
  ].join('\n');
}

function darwinSandboxProfile(workspace: string): string {
  const root = sandboxString(workspace);
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read-data
  (literal "/")
  (subpath "/System")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/opt/homebrew")
  (subpath "/Library")
  (subpath "/dev")
  (subpath "${root}"))
(allow file-write* (subpath "${root}"))
(allow file-write-data (literal "/dev/null"))`;
}

function sandboxString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

function shellEnvironment(workspace: string, cwd: string): NodeJS.ProcessEnv {
  const temporaryDirectory = `${workspace}/tmp`;
  return {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: workspace,
    TMPDIR: temporaryDirectory,
    PWD: cwd,
    SHELL: SHELL_PATH,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'dumb',
    CI: '1',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_CACHE: `${temporaryDirectory}/npm-cache`,
  };
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
