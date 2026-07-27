import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createConnection, createServer } from 'node:net';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from '../config/runtime-config.js';
import type { AgentManagedProcess } from '../domain/index.js';
import type { RuntimeEventPublisher } from '../runtime/events/runtime-event-writer.js';
import {
  RuntimeToolExecutionError,
  type RuntimeToolContext,
} from '../runtime/execution/tool-executor.js';
import { buildWorkspaceProcessEnv } from './helpers/process-environment.helper.js';
import { WORKSPACE_PROCESS_SUPERVISOR_SOURCE } from './helpers/process-supervisor-script.helper.js';
import { workspaceRoot } from './helpers/workspace-path.helper.js';

const PROCESS_SPEC_VERSION = 1;
const MANAGED_PROCESS_LIMITS = {
  defaultHost: '127.0.0.1',
  allowedHosts: ['127.0.0.1', 'localhost'],
  stopGraceMs: 1_500,
  readinessPollMs: 100,
  discoveryPollMs: 1_000,
  maximumLogBytes: 64 * 1_024,
  socketTimeoutMs: 250,
  discoveryCommandMaximumBytes: 4 * 1_024 * 1_024,
};

export type ManagedProcessToolConfig =
  ToolsConfig['managedProcesses'] & typeof MANAGED_PROCESS_LIMITS;

export function resolveManagedProcessToolConfig(
  config: ToolsConfig['managedProcesses']
): ManagedProcessToolConfig {
  return {
    ...config,
    ...MANAGED_PROCESS_LIMITS,
  };
}

interface StartManagedProcessInput {
  context: RuntimeToolContext;
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  host?: string;
  port?: number | 'auto';
  startupTimeoutMs?: number;
}

interface WorkspaceProcessSpec {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  jobId: string;
  toolInvocationId: string;
  ownershipToken: string;
  name: string;
  command: string;
  cwd: string;
  host: string;
  port: number;
  url: string;
  logPath: string;
  absoluteLogPath: string;
  createdAtMs: number;
}

interface RegistryEntry {
  record: AgentManagedProcess;
  spec: WorkspaceProcessSpec;
}

interface DiscoveredSupervisor {
  pid: number;
  processGroupId: number;
  processId: string;
  sessionId: string;
  ownershipToken: string;
}

/**
 * Supervises local development servers without treating OS process state as
 * durable business data. Live state comes from marked supervisor processes;
 * the filesystem contains only a local launch spec and logs needed to adopt a
 * surviving process after the Runtime itself restarts.
 */
export class ManagedProcessManager {
  readonly #registry = new Map<string, RegistryEntry>();
  readonly #children = new Map<string, ChildProcess>();
  readonly #processConfig: ManagedProcessToolConfig;
  #discoveryTimer?: ReturnType<typeof setInterval>;
  #refreshing?: Promise<void>;

  constructor(
    private readonly publisher?: RuntimeEventPublisher,
    private readonly clock: { nowMs(): number } = { nowMs: () => Date.now() },
    private readonly sandboxRoot = resolve(process.cwd(), '.agent-sandbox'),
    private readonly toolsConfig: ToolsConfig = DEFAULT_TOOLS_CONFIG
  ) {
    this.#processConfig = resolveManagedProcessToolConfig(
      toolsConfig.managedProcesses
    );
  }

  async start(): Promise<void> {
    if (this.#discoveryTimer) return;
    await this.#refreshFromOperatingSystem();
    this.#discoveryTimer = setInterval(() => {
      void this.#refreshFromOperatingSystem().catch(() => {
        // A later scan can recover from a transient ps/filesystem failure.
      });
    }, this.#processConfig.discoveryPollMs);
    this.#discoveryTimer.unref();
  }

  shutdown(): void {
    if (this.#discoveryTimer) clearInterval(this.#discoveryTimer);
    this.#discoveryTimer = undefined;
  }

  async startProcess(input: StartManagedProcessInput): Promise<AgentManagedProcess> {
    await this.#refreshFromOperatingSystem();
    const name = input.name.trim();
    const rawCommand = input.command.trim();
    if (!name) throw new TypeError('Managed process name is required.');
    if (!rawCommand) throw new TypeError('Managed process command is required.');
    const host = input.host?.trim() || this.#processConfig.defaultHost;
    if (!this.#processConfig.allowedHosts.includes(host)) {
      throw new RuntimeToolExecutionError(
        'invalid_process_host',
        'Managed development servers must bind to 127.0.0.1 or localhost.'
      );
    }

    const processId = processIdForInvocation(input.context.toolInvocationId);
    const existingForInvocation = this.#registry.get(processId)?.record;
    if (existingForInvocation && isActive(existingForInvocation.status)) {
      return existingForInvocation;
    }
    const conflictingName = [...this.#registry.values()].find(entry => (
      entry.record.sessionId === input.context.sessionId
      && entry.record.name === name
      && isActive(entry.record.status)
    ));
    if (conflictingName) {
      throw new RuntimeToolExecutionError(
        'managed_process_conflict',
        `An active process already uses name ${JSON.stringify(name)} in this Session.`,
        { processId: conflictingName.record.id, name }
      );
    }

    const port = input.port === undefined || input.port === 'auto'
      ? await findAvailablePort(host, this.#processConfig)
      : normalizePort(input.port);
    if (!await isPortAvailable(host, port)) {
      throw new RuntimeToolExecutionError(
        'process_port_unavailable',
        `Port ${host}:${port} is already in use. Use port="auto" instead of killing an unrelated process.`,
        { host, port }
      );
    }

    const root = await realpath(await workspaceRoot(input.context));
    const cwdInput = input.cwd?.trim() || '.';
    const cwd = await realpath(isAbsolute(cwdInput) ? cwdInput : resolve(root, cwdInput));
    if (!(await lstat(cwd)).isDirectory()) {
      throw new Error(`Process cwd is not a directory: ${cwdInput}`);
    }
    const processDirectory = resolve(root, '.runtime', 'processes', processId);
    await mkdir(processDirectory, { recursive: true });
    const supervisorPath = resolve(processDirectory, 'workspace-process-supervisor.mjs');
    const logicalLogPath = `.runtime/processes/${processId}/process.log`;
    const absoluteLogPath = resolve(root, logicalLogPath);
    const url = `http://${host === 'localhost' ? 'localhost' : host}:${port}`;
    const substitutions = { PORT: String(port), HOST: host };
    const command = substitute(rawCommand, substitutions);
    const environmentOverrides = Object.fromEntries(
      Object.entries(input.env ?? {}).map(([key, value]) => [
        key,
        substitute(value, substitutions),
      ])
    );
    environmentOverrides.PORT ??= String(port);
    environmentOverrides.HOST ??= host;
    environmentOverrides.BROWSER ??= 'none';
    const nowMs = this.clock.nowMs();
    const spec: WorkspaceProcessSpec = {
      schemaVersion: PROCESS_SPEC_VERSION,
      id: processId,
      sessionId: input.context.sessionId,
      jobId: input.context.jobId,
      toolInvocationId: input.context.toolInvocationId,
      ownershipToken: randomBytes(24).toString('hex'),
      name,
      command,
      cwd,
      host,
      port,
      url,
      logPath: logicalLogPath,
      absoluteLogPath,
      createdAtMs: nowMs,
    };
    const specPath = processSpecPath(this.sandboxRoot, spec.sessionId, spec.id);
    try {
      await writeFile(supervisorPath, WORKSPACE_PROCESS_SUPERVISOR_SOURCE, {
        encoding: 'utf8',
        mode: 0o500,
        flag: 'wx',
      });
      await chmod(supervisorPath, 0o500);
      await writeFile(specPath, JSON.stringify(spec), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(specPath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = await this.#discoverById(processId);
        if (existing) return existing;
        throw new RuntimeToolExecutionError(
          'managed_process_conflict',
          `Tool invocation ${JSON.stringify(input.context.toolInvocationId)} already created a local process.`,
          { processId }
        );
      }
      throw error;
    }

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [
        supervisorPath,
        `--agent-runtime-process-id=${spec.id}`,
        `--agent-runtime-session-id=${spec.sessionId}`,
        `--agent-runtime-owner-token=${spec.ownershipToken}`,
        `--agent-runtime-spec=${specPath}`,
      ], {
        cwd,
        env: buildWorkspaceProcessEnv(
          environmentOverrides,
          this.toolsConfig.hostEnvironment
        ),
        detached: true,
        stdio: 'ignore',
      });
    } catch (error) {
      const failed = this.#register(spec, {
        status: 'failed',
        error: { code: 'process_spawn_failed', message: errorMessage(error) },
      });
      throw new RuntimeToolExecutionError('process_spawn_failed', failed.error!.message, failed);
    }
    if (child.pid === undefined) {
      const failed = this.#register(spec, {
        status: 'failed',
        error: {
          code: 'process_spawn_failed',
          message: 'The operating system did not assign a supervisor process id.',
        },
      });
      throw new RuntimeToolExecutionError('process_spawn_failed', failed.error!.message, failed);
    }

    child.unref();
    this.#children.set(processId, child);
    let record = this.#register(spec, {
      status: 'starting',
      pid: child.pid,
      processGroupId: child.pid,
    });
    await this.#publish(record);
    const exit = childExit(child);
    const startupTimeoutMs = normalizeStartupTimeout(
      input.startupTimeoutMs,
      this.#processConfig
    );
    try {
      const outcome = await Promise.race([
        waitForTcp(
          host,
          port,
          startupTimeoutMs,
          this.#processConfig,
          input.context.signal
        )
          .then(() => ({ type: 'ready' as const })),
        exit.then(value => ({ type: 'exit' as const, value })),
      ]);
      if (outcome.type === 'exit') {
        this.#children.delete(processId);
        record = await this.#transition(processId, {
          status: 'failed',
          exitCode: outcome.value.exitCode ?? undefined,
          exitSignal: outcome.value.signal ?? undefined,
          error: {
            code: 'process_exited_before_ready',
            message: `Process exited before ${host}:${port} became ready.`,
            details: { ...outcome.value, logPath: logicalLogPath },
          },
        });
        throw new RuntimeToolExecutionError(
          'process_exited_before_ready',
          record.error!.message,
          { process: record, logs: await this.readLogs(processId) }
        );
      }
      record = await this.#transition(processId, {
        status: 'running',
        pid: child.pid,
        processGroupId: child.pid,
      });
      void exit.then(value => this.#recordUnexpectedExit(processId, value)).catch(() => undefined);
      return record;
    } catch (error) {
      if (error instanceof RuntimeToolExecutionError) throw error;
      await terminateKnownChild(
        child.pid,
        this.#processConfig.stopGraceMs
      );
      this.#children.delete(processId);
      const aborted = input.context.signal?.aborted || isAbortError(error);
      record = await this.#transition(processId, {
        status: aborted ? 'stopped' : 'failed',
        error: aborted ? undefined : {
          code: 'process_start_timeout',
          message: `Process did not listen on ${host}:${port} within ${startupTimeoutMs}ms.`,
          details: { logPath: logicalLogPath },
        },
      });
      if (aborted) throw abortError();
      throw new RuntimeToolExecutionError(
        'process_start_timeout',
        record.error!.message,
        { process: record, logs: await this.readLogs(processId) }
      );
    }
  }

  async getProcess(processId: string): Promise<AgentManagedProcess> {
    await this.#refreshFromOperatingSystem();
    return this.#requireEntry(processId).record;
  }

  async listSessionProcesses(sessionId: string): Promise<AgentManagedProcess[]> {
    await this.#refreshFromOperatingSystem();
    return [...this.#registry.values()]
      .map(entry => entry.record)
      .filter(record => record.sessionId === sessionId)
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id));
  }

  async readLogs(
    processId: string,
    maxBytes = this.#processConfig.maximumLogBytes
  ): Promise<string> {
    await this.#refreshFromOperatingSystem();
    const spec = this.#requireEntry(processId).spec;
    const contents = await readFile(spec.absoluteLogPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    });
    const limit = Math.min(
      this.#processConfig.maximumLogBytes,
      Math.max(1_024, Math.round(maxBytes))
    );
    return contents.subarray(Math.max(0, contents.byteLength - limit)).toString('utf8');
  }

  async stopProcess(processId: string): Promise<AgentManagedProcess> {
    await this.#refreshFromOperatingSystem();
    const entry = this.#requireEntry(processId);
    if (!isActive(entry.record.status)) return entry.record;
    const supervisor = await this.#findOwnedSupervisor(entry.spec);
    if (!supervisor) {
      return this.#transition(processId, {
        status: 'unknown',
        error: {
          code: 'process_identity_lost',
          message: 'The marked supervisor process no longer exists; no PID was signalled.',
        },
      });
    }
    await this.#transition(processId, { status: 'stopping' });
    await terminateOwnedProcessGroup(
      entry.spec,
      supervisor.processGroupId,
      this.#processConfig
    );
    this.#children.delete(processId);
    return this.#transition(processId, { status: 'stopped' });
  }

  async stopSessionProcesses(sessionId: string): Promise<void> {
    const processes = await this.listSessionProcesses(sessionId);
    await Promise.all(processes
      .filter(item => isActive(item.status))
      .map(item => this.stopProcess(item.id)));
  }

  #register(
    spec: WorkspaceProcessSpec,
    state: Pick<AgentManagedProcess, 'status'>
      & Partial<Pick<AgentManagedProcess, 'pid' | 'processGroupId' | 'error'>>
  ): AgentManagedProcess {
    const existing = this.#registry.get(spec.id)?.record;
    const nowMs = this.clock.nowMs();
    const terminal = isTerminal(state.status);
    const record: AgentManagedProcess = {
      id: spec.id,
      sessionId: spec.sessionId,
      jobId: spec.jobId,
      toolInvocationId: spec.toolInvocationId,
      name: spec.name,
      command: spec.command,
      cwd: logicalPath(
        resolve(this.sandboxRoot, 'sessions', spec.sessionId, 'workspace'),
        spec.cwd
      ),
      status: state.status,
      ...(state.pid === undefined ? {} : { pid: state.pid }),
      ...(state.processGroupId === undefined ? {} : { processGroupId: state.processGroupId }),
      host: spec.host,
      port: spec.port,
      url: spec.url,
      logPath: spec.logPath,
      ...(state.error ? { error: state.error } : {}),
      version: existing?.version === undefined ? 0 : existing.version + 1,
      metadata: { source: 'os_process_marker', readiness: 'tcp' },
      createdAtMs: spec.createdAtMs,
      ...(state.status === 'running'
        ? { startedAtMs: existing?.startedAtMs ?? nowMs }
        : existing?.startedAtMs === undefined ? {} : { startedAtMs: existing.startedAtMs }),
      updatedAtMs: nowMs,
      ...(terminal ? { completedAtMs: nowMs } : {}),
    };
    this.#registry.set(spec.id, { spec, record });
    return record;
  }

  async #transition(
    processId: string,
    patch: {
      status: AgentManagedProcess['status'];
      pid?: number;
      processGroupId?: number;
      exitCode?: number;
      exitSignal?: string;
      error?: AgentManagedProcess['error'];
    }
  ): Promise<AgentManagedProcess> {
    const entry = this.#requireEntry(processId);
    const current = entry.record;
    const nowMs = this.clock.nowMs();
    const terminal = isTerminal(patch.status);
    const updated: AgentManagedProcess = {
      ...current,
      status: patch.status,
      ...(patch.pid === undefined ? {} : { pid: patch.pid }),
      ...(patch.processGroupId === undefined ? {} : { processGroupId: patch.processGroupId }),
      ...(patch.exitCode === undefined ? {} : { exitCode: patch.exitCode }),
      ...(patch.exitSignal === undefined ? {} : { exitSignal: patch.exitSignal }),
      ...(patch.error === undefined ? { error: undefined } : { error: patch.error }),
      version: current.version + 1,
      updatedAtMs: nowMs,
      ...(patch.status === 'running'
        ? { startedAtMs: current.startedAtMs ?? nowMs }
        : {}),
      ...(terminal ? { completedAtMs: nowMs } : { completedAtMs: undefined }),
    };
    this.#registry.set(processId, { ...entry, record: updated });
    await this.#publish(updated);
    return updated;
  }

  async #recordUnexpectedExit(
    processId: string,
    value: { exitCode: number | null; signal: NodeJS.Signals | null }
  ): Promise<void> {
    this.#children.delete(processId);
    const current = this.#registry.get(processId)?.record;
    if (!current || !isActive(current.status)) return;
    await this.#transition(processId, {
      status: current.status === 'stopping' ? 'stopped' : 'exited',
      exitCode: value.exitCode ?? undefined,
      exitSignal: value.signal ?? undefined,
    });
  }

  async #discoverById(processId: string): Promise<AgentManagedProcess | undefined> {
    await this.#refreshFromOperatingSystem();
    return this.#registry.get(processId)?.record;
  }

  async #refreshFromOperatingSystem(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#doRefreshFromOperatingSystem().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #doRefreshFromOperatingSystem(): Promise<void> {
    const supervisors = await listMarkedSupervisors(
      this.#processConfig.discoveryCommandMaximumBytes
    );
    const activeIds = new Set<string>();
    for (const supervisor of supervisors) {
      let spec: WorkspaceProcessSpec;
      try {
        spec = await readProcessSpec(
          processSpecPath(this.sandboxRoot, supervisor.sessionId, supervisor.processId)
        );
      } catch {
        continue;
      }
      if (
        spec.id !== supervisor.processId
        || spec.sessionId !== supervisor.sessionId
        || spec.ownershipToken !== supervisor.ownershipToken
      ) {
        continue;
      }
      activeIds.add(spec.id);
      const status = await isTcpOpen(
        spec.host,
        spec.port,
        this.#processConfig.socketTimeoutMs
      ) ? 'running' : 'starting';
      const existing = this.#registry.get(spec.id)?.record;
      if (
        existing
        && existing.pid === supervisor.pid
        && existing.processGroupId === supervisor.processGroupId
        && existing.status === status
      ) {
        continue;
      }
      const record = this.#register(spec, {
        status,
        pid: supervisor.pid,
        processGroupId: supervisor.processGroupId,
      });
      await this.#publish(record);
    }

    for (const [processId, entry] of this.#registry) {
      if (!isActive(entry.record.status) || activeIds.has(processId)) continue;
      await this.#transition(processId, {
        status: 'exited',
        error: {
          code: 'process_supervisor_exited',
          message: 'The marked local supervisor process is no longer running.',
        },
      });
    }
  }

  async #findOwnedSupervisor(
    spec: WorkspaceProcessSpec
  ): Promise<DiscoveredSupervisor | undefined> {
    return (await listMarkedSupervisors(
      this.#processConfig.discoveryCommandMaximumBytes
    )).find(processInfo => (
      processInfo.processId === spec.id
      && processInfo.sessionId === spec.sessionId
      && processInfo.ownershipToken === spec.ownershipToken
    ));
  }

  #requireEntry(processId: string): RegistryEntry {
    const entry = this.#registry.get(processId);
    if (!entry) {
      throw new RuntimeToolExecutionError(
        'managed_process_not_found',
        `Local process ${JSON.stringify(processId)} was not found.`
      );
    }
    return entry;
  }

  async #publish(processRecord: AgentManagedProcess): Promise<void> {
    try {
      await this.publisher?.publish({
        type: 'managed_process.upserted',
        sessionId: processRecord.sessionId,
        process: processRecord,
      });
    } catch {
      // A live process scan repairs the client after an SSE publish failure.
    }
  }
}

function processIdForInvocation(toolInvocationId: string): string {
  return `process_${createHash('sha256').update(toolInvocationId).digest('hex').slice(0, 32)}`;
}

function processSpecPath(sandboxRoot: string, sessionId: string, processId: string): string {
  assertSafeId(sessionId, 'session');
  assertSafeId(processId, 'process');
  return resolve(
    sandboxRoot,
    'sessions',
    sessionId,
    'workspace',
    '.runtime',
    'processes',
    processId,
    'process.json'
  );
}

async function readProcessSpec(path: string): Promise<WorkspaceProcessSpec> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (
    !parsed
    || typeof parsed !== 'object'
    || (parsed as { schemaVersion?: unknown }).schemaVersion !== PROCESS_SPEC_VERSION
  ) {
    throw new Error(`Invalid local process spec: ${path}`);
  }
  const spec = parsed as WorkspaceProcessSpec;
  for (const [name, value] of Object.entries({
    id: spec.id,
    sessionId: spec.sessionId,
    jobId: spec.jobId,
    toolInvocationId: spec.toolInvocationId,
    ownershipToken: spec.ownershipToken,
    name: spec.name,
    command: spec.command,
    cwd: spec.cwd,
    host: spec.host,
    url: spec.url,
    logPath: spec.logPath,
    absoluteLogPath: spec.absoluteLogPath,
  })) {
    if (typeof value !== 'string' || !value) {
      throw new Error(`Local process spec field ${name} is invalid.`);
    }
  }
  normalizePort(spec.port);
  return spec;
}

async function listMarkedSupervisors(
  maximumOutputBytes: number
): Promise<DiscoveredSupervisor[]> {
  const output = await execFileText(
    '/bin/ps',
    ['-axo', 'pid=,pgid=,command=', '-ww'],
    maximumOutputBytes
  );
  const discovered: DiscoveredSupervisor[] = [];
  for (const line of output.split('\n')) {
    const columns = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!columns) continue;
    const command = columns[3]!;
    const processId = marker(command, '--agent-runtime-process-id');
    const sessionId = marker(command, '--agent-runtime-session-id');
    const ownershipToken = marker(command, '--agent-runtime-owner-token');
    if (!processId || !sessionId || !ownershipToken) continue;
    if (!command.includes('workspace-process-supervisor')) continue;
    discovered.push({
      pid: Number(columns[1]),
      processGroupId: Number(columns[2]),
      processId,
      sessionId,
      ownershipToken,
    });
  }
  return discovered;
}

function marker(command: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}=([A-Za-z0-9_.-]+)(?:\\s|$)`).exec(command)?.[1];
}

function execFileText(
  file: string,
  args: string[],
  maximumOutputBytes: number
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { maxBuffer: maximumOutputBytes }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout);
    });
  });
}

async function terminateOwnedProcessGroup(
  spec: WorkspaceProcessSpec,
  processGroupId: number,
  config: ManagedProcessToolConfig
): Promise<void> {
  const verify = async () => (await listMarkedSupervisors(
    config.discoveryCommandMaximumBytes
  )).some(item => (
    item.processGroupId === processGroupId
    && item.processId === spec.id
    && item.sessionId === spec.sessionId
    && item.ownershipToken === spec.ownershipToken
  ));
  if (!await verify()) return;
  sendSignal(processGroupId, 'SIGTERM');
  const deadline = Date.now() + config.stopGraceMs;
  while (Date.now() < deadline) {
    if (!await verify()) return;
    await delay(50);
  }
  if (await verify()) sendSignal(processGroupId, 'SIGKILL');
}

async function terminateKnownChild(
  processGroupId: number,
  stopGraceMs: number
): Promise<void> {
  if (!isProcessAlive(processGroupId)) return;
  sendSignal(processGroupId, 'SIGTERM');
  const deadline = Date.now() + stopGraceMs;
  while (Date.now() < deadline && isProcessAlive(processGroupId)) await delay(50);
  if (isProcessAlive(processGroupId)) sendSignal(processGroupId, 'SIGKILL');
}

function sendSignal(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function findAvailablePort(
  host: string,
  config: ManagedProcessToolConfig
): Promise<number> {
  for (let port = config.portRangeStart; port <= config.portRangeEnd; port += 1) {
    if (await isPortAvailable(host, port)) return port;
  }
  throw new RuntimeToolExecutionError(
    'no_available_process_port',
    `No available development-server port was found between `
      + `${config.portRangeStart} and ${config.portRangeEnd}.`
  );
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolvePromise(false));
    server.listen(port, host, () => server.close(() => resolvePromise(true)));
  });
}

function isTcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once('error', () => resolvePromise(false));
  });
}

async function waitForTcp(
  host: string,
  port: number,
  timeoutMs: number,
  config: ManagedProcessToolConfig,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    if (await isTcpOpen(host, port, config.socketTimeoutMs)) return;
    await delay(config.readinessPollMs, signal);
  }
  throw new Error('readiness timeout');
}

function childExit(child: ChildProcess): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise(resolvePromise => {
    child.once('error', () => resolvePromise({ exitCode: null, signal: null }));
    child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal }));
  });
}

function normalizePort(port: number): number {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new RangeError('Process port must be an integer between 1 and 65535.');
  }
  return port;
}

function normalizeStartupTimeout(
  value: number | undefined,
  config: ManagedProcessToolConfig
): number {
  if (!Number.isFinite(value)) return config.defaultStartupTimeoutMs;
  return Math.min(
    config.maximumStartupTimeoutMs,
    Math.max(1_000, Math.round(value!))
  );
}

function logicalPath(root: string, path: string): string {
  const relation = relative(root, path);
  return relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ? path
    : relation || '.';
}

function substitute(value: string, variables: Record<string, string>): string {
  return Object.entries(variables).reduce(
    (result, [key, replacement]) => result.replaceAll(`{${key}}`, replacement),
    value
  );
}

function isActive(status: AgentManagedProcess['status']): boolean {
  return ['starting', 'running', 'stopping'].includes(status);
}

function isTerminal(status: AgentManagedProcess['status']): boolean {
  return ['stopped', 'exited', 'failed', 'unknown'].includes(status);
}

function assertSafeId(value: string, type: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value.trim())) {
    throw new Error(`Invalid ${type} id: ${value}`);
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onDone = () => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    };
    const timer = setTimeout(onDone, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('Process start was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
