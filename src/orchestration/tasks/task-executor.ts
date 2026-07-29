import { DEFAULT_EXECUTION_CONFIG } from '../../config/runtime-config.js';
import type { AgentTask, AgentTaskRun } from '../../domain/index.js';
import type { ReActExecution } from '../../runtime/execution/react-execution.js';
import { RuntimeError } from '../../runtime/errors/runtime-error.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { ExecutionOwnershipService } from './shared/execution-ownership.service.js';

export interface ExecuteTaskRunCommand {
  taskId: string;
  taskRunId: string;
}

export interface TaskExecutorPort {
  execute(command: ExecuteTaskRunCommand): Promise<void>;
  abortExecution(taskId: string): void;
  abortSessionExecutions(sessionId: string): Promise<void>;
}

export interface TaskExecutorOptions {
  store: AgentStore;
  reactExecution: Pick<ReActExecution, 'runTask'>;
  workerId: string;
  ownershipTimeoutMs?: number;
  ownershipRefreshMs?: number;
  terminationGraceMs?: number;
  clock?: { nowMs(): number };
}

interface ActiveExecution {
  taskId: string;
  sessionId: string;
  controller: AbortController;
  completion: Promise<void>;
}

/** Consumes one TaskRun command; durable lifecycle changes stay in stores/flows. */
export class TaskExecutor implements TaskExecutorPort {
  readonly #executionsByRunId = new Map<string, ActiveExecution>();
  readonly #options: Required<Omit<TaskExecutorOptions,
    'store' | 'reactExecution' | 'workerId'>> & TaskExecutorOptions;
  readonly #executionOwnership: ExecutionOwnershipService;
  #stopping = false;

  constructor(options: TaskExecutorOptions) {
    this.#options = {
      ownershipTimeoutMs: DEFAULT_EXECUTION_CONFIG.ownershipTimeoutMs,
      ownershipRefreshMs: DEFAULT_EXECUTION_CONFIG.ownershipRefreshMs,
      terminationGraceMs: 5_000,
      clock: { nowMs: () => Date.now() },
      ...options,
    };
    if (this.#options.ownershipRefreshMs >= this.#options.ownershipTimeoutMs) {
      throw new RangeError('ownershipRefreshMs must be shorter than ownershipTimeoutMs.');
    }
    if (!Number.isInteger(this.#options.terminationGraceMs)
      || this.#options.terminationGraceMs <= 0) {
      throw new RangeError('terminationGraceMs must be a positive integer.');
    }
    this.#executionOwnership = new ExecutionOwnershipService({
      store: options.store,
      ownerId: options.workerId,
      refreshIntervalMs: this.#options.ownershipRefreshMs,
      ownershipTimeoutMs: this.#options.ownershipTimeoutMs,
      clock: this.#options.clock,
    });
  }

  async execute(command: ExecuteTaskRunCommand): Promise<void> {
    if (this.#stopping) return;
    const existing = this.#executionsByRunId.get(command.taskRunId);
    if (existing) return existing.completion;

    const selected = await this.#loadRunnableTask(command);
    if (this.#stopping) return;
    const concurrentlyStarted = this.#executionsByRunId.get(command.taskRunId);
    if (concurrentlyStarted) return concurrentlyStarted.completion;

    const execution = {
      taskId: command.taskId,
      sessionId: selected.task.sessionId,
      controller: new AbortController(),
      completion: Promise.resolve(),
    };
    this.#executionsByRunId.set(command.taskRunId, execution);
    execution.completion = this.#runOwnedTask(
      selected,
      execution.controller
    ).finally(() => {
      if (this.#executionsByRunId.get(command.taskRunId) === execution) {
        this.#executionsByRunId.delete(command.taskRunId);
      }
    });
    return execution.completion;
  }

  abortExecution(taskId: string): void {
    for (const execution of this.#executionsByRunId.values()) {
      if (execution.taskId === taskId) execution.controller.abort('task_cancelled');
    }
  }

  async abortSessionExecutions(sessionId: string): Promise<void> {
    const active = [...this.#executionsByRunId.values()]
      .filter(execution => execution.sessionId === sessionId);
    for (const execution of active) execution.controller.abort('session_deletion');
    if (active.length === 0) return;
    const stopped = await settleWithin(
      active.map(execution => execution.completion),
      this.#options.terminationGraceMs
    );
    if (!stopped) {
      throw new RuntimeError(
        'execution_stop_timeout',
        `Session ${JSON.stringify(sessionId)} still has active execution after the deletion grace period.`,
        { retryable: true, details: { sessionId, activeExecutions: active.length } }
      );
    }
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    const active = [...this.#executionsByRunId.values()];
    for (const execution of active) execution.controller.abort('runtime_shutdown');
    await settleWithin(
      active.map(execution => execution.completion),
      this.#options.terminationGraceMs
    );
  }

  async #runOwnedTask(
    runnable: { task: AgentTask; taskRun: AgentTaskRun },
    controller: AbortController
  ): Promise<void> {
    let stopRefreshing: () => void = () => undefined;
    let stopRefreshingOnAbort: (() => void) | undefined;
    try {
      stopRefreshing = this.#executionOwnership.startRefreshing({
        taskId: runnable.task.id,
        taskRunId: runnable.taskRun.id,
        ownershipExpiresAtMs: runnable.taskRun.ownershipExpiresAtMs!,
        onOwnershipLost: () => controller.abort('ownership_lost'),
      });
      stopRefreshingOnAbort = () => stopRefreshing();
      controller.signal.addEventListener('abort', stopRefreshingOnAbort, { once: true });
      if (controller.signal.aborted) stopRefreshingOnAbort();
      await this.#options.reactExecution.runTask({ ...runnable, signal: controller.signal });
    } catch (error) {
      if (!(error instanceof RuntimeError
        && ['ownership_lost', 'aborted'].includes(error.code))) throw error;
    } finally {
      if (stopRefreshingOnAbort) {
        controller.signal.removeEventListener('abort', stopRefreshingOnAbort);
      }
      stopRefreshing();
    }
  }

  async #loadRunnableTask(command: ExecuteTaskRunCommand): Promise<{
    task: AgentTask;
    taskRun: AgentTaskRun;
  }> {
    const [task, taskRun] = await Promise.all([
      this.#options.store.tasks.get(command.taskId),
      this.#options.store.tasks.getRun(command.taskRunId),
    ]);
    const nowMs = this.#options.clock.nowMs();
    if (!task || task.status !== 'running' || !taskRun || taskRun.status !== 'running'
      || taskRun.taskId !== command.taskId
      || taskRun.ownerId !== this.#options.workerId
      || !taskRun.ownershipExpiresAtMs
      || taskRun.ownershipExpiresAtMs <= nowMs) {
      throw new RuntimeError(
        'ownership_lost',
        `TaskRun ${JSON.stringify(command.taskRunId)} is not owned by this worker.`
      );
    }
    return { task, taskRun };
  }
}

async function settleWithin(promises: Promise<void>[], timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const settled = Promise.allSettled(promises).then(() => true as const);
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
