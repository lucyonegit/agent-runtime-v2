import { DEFAULT_EXECUTION_CONFIG } from '../../config/runtime-config.js';
import type { AgentTask, AgentTaskRun } from '../../domain/index.js';
import type { ReActExecution } from '../../runtime/execution/react-execution.js';
import { RuntimeError } from '../../runtime/errors/runtime-error.js';
import type { RuntimeEventPublisher } from '../../runtime/events/runtime-event-writer.js';
import { taskFinishEvents } from '../../runtime/events/helpers/task-finish-events.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { ExecutionOwnershipService } from './shared/execution-ownership.service.js';
import { InterruptedTaskScanner } from './shared/interrupted-task-scanner.js';

export interface TaskExecutorPort {
  start(): Promise<void>;
  startExecution(taskId: string): Promise<void>;
  abortExecution(taskId: string): void;
  abortSessionExecutions(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TaskExecutorOptions {
  store: AgentStore;
  reactExecution: Pick<ReActExecution, 'runTask'>;
  workerId: string;
  publisher: RuntimeEventPublisher;
  ownershipTimeoutMs?: number;
  ownershipRefreshMs?: number;
  recoveryIntervalMs?: number;
  recoveryBatchSize?: number;
  terminationGraceMs?: number;
  clock?: { nowMs(): number };
}

interface ActiveExecution {
  taskId: string;
  sessionId: string;
  taskRunId: string;
  controller: AbortController;
  completion: Promise<void>;
}

/** Owns process-local scheduling; durable lifecycle changes stay in stores/flows. */
export class TaskExecutor implements TaskExecutorPort {
  readonly #activeExecutions = new Map<string, ActiveExecution>();
  readonly #trackedExecutions = new Set<ActiveExecution>();
  readonly #options: Required<Omit<TaskExecutorOptions,
    'store' | 'reactExecution' | 'publisher' | 'workerId'>> & TaskExecutorOptions;
  readonly #executionOwnership: ExecutionOwnershipService;
  readonly #interruptedTaskScanner: InterruptedTaskScanner;
  #stopping = false;

  constructor(options: TaskExecutorOptions) {
    this.#options = {
      ownershipTimeoutMs: DEFAULT_EXECUTION_CONFIG.ownershipTimeoutMs,
      ownershipRefreshMs: DEFAULT_EXECUTION_CONFIG.ownershipRefreshMs,
      recoveryIntervalMs: DEFAULT_EXECUTION_CONFIG.recoveryScanIntervalMs,
      recoveryBatchSize: DEFAULT_EXECUTION_CONFIG.recoveryBatchSize,
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
    this.#interruptedTaskScanner = new InterruptedTaskScanner({
      store: options.store,
      publisher: options.publisher,
      scanIntervalMs: this.#options.recoveryIntervalMs,
      batchSize: this.#options.recoveryBatchSize,
      clock: this.#options.clock,
      ownerId: options.workerId,
      ownershipTimeoutMs: this.#options.ownershipTimeoutMs,
      onTaskReady: taskId => { void this.startExecution(taskId); },
    });
  }

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#interruptedTaskScanner.start();
  }

  async startExecution(taskId: string): Promise<void> {
    if (this.#stopping) return;
    const selected = await this.#loadRunnableTask(taskId);
    const existing = this.#activeExecutions.get(taskId);
    if (existing?.taskRunId === selected.taskRun.id) return existing.completion;

    const execution = {
      taskId,
      sessionId: selected.task.sessionId,
      taskRunId: selected.taskRun.id,
      controller: new AbortController(),
      completion: Promise.resolve(),
    };
    this.#activeExecutions.set(taskId, execution);
    this.#trackedExecutions.add(execution);
    existing?.controller.abort('task_run_superseded');
    execution.completion = this.#runOwnedTask(
      taskId,
      selected.taskRun.id,
      execution.controller
    ).finally(() => {
      this.#trackedExecutions.delete(execution);
      if (this.#activeExecutions.get(taskId) === execution) this.#activeExecutions.delete(taskId);
    });
    return execution.completion;
  }

  abortExecution(taskId: string): void {
    for (const execution of this.#trackedExecutions) {
      if (execution.taskId === taskId) execution.controller.abort('task_cancelled');
    }
  }

  async abortSessionExecutions(sessionId: string): Promise<void> {
    const active = [...this.#trackedExecutions]
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
    await this.#interruptedTaskScanner.stop();
    const active = [...this.#trackedExecutions];
    for (const execution of active) execution.controller.abort('runtime_shutdown');
    await settleWithin(
      active.map(execution => execution.completion),
      this.#options.terminationGraceMs
    );
  }

  async #runOwnedTask(
    taskId: string,
    expectedTaskRunId: string,
    controller: AbortController
  ): Promise<void> {
    let runnable: { task: AgentTask; taskRun: AgentTaskRun } | undefined;
    let stopRefreshing: () => void = () => undefined;
    let stopRefreshingOnAbort: (() => void) | undefined;
    try {
      runnable = await this.#loadRunnableTask(taskId, expectedTaskRunId);
      stopRefreshing = this.#executionOwnership.startRefreshing({
        taskId,
        taskRunId: runnable.taskRun.id,
        ownershipExpiresAtMs: runnable.taskRun.ownershipExpiresAtMs!,
        onOwnershipLost: () => controller.abort('ownership_lost'),
      });
      stopRefreshingOnAbort = () => stopRefreshing();
      controller.signal.addEventListener('abort', stopRefreshingOnAbort, { once: true });
      if (controller.signal.aborted) stopRefreshingOnAbort();
      await this.#options.reactExecution.runTask({ ...runnable, signal: controller.signal });
    } catch (error) {
      if (!(error instanceof RuntimeError && ['ownership_lost', 'aborted'].includes(error.code))) {
        await this.#failTaskIfStillOwned(runnable, error);
      }
    } finally {
      if (stopRefreshingOnAbort) {
        controller.signal.removeEventListener('abort', stopRefreshingOnAbort);
      }
      stopRefreshing();
    }
  }

  async #loadRunnableTask(
    taskId: string,
    expectedTaskRunId?: string
  ): Promise<{ task: AgentTask; taskRun: AgentTaskRun }> {
    const [task, taskRun] = await Promise.all([
      this.#options.store.tasks.get(taskId),
      this.#options.store.tasks.getLatestRun(taskId),
    ]);
    const nowMs = this.#options.clock.nowMs();
    if (!task || task.status !== 'running' || !taskRun || taskRun.status !== 'running'
      || expectedTaskRunId !== undefined && taskRun.id !== expectedTaskRunId
      || taskRun.ownerId !== this.#options.workerId
      || !taskRun.ownershipExpiresAtMs
      || taskRun.ownershipExpiresAtMs <= nowMs) {
      throw new RuntimeError('ownership_lost', `Task ${taskId} is not owned by this worker.`);
    }
    return { task, taskRun };
  }

  async #failTaskIfStillOwned(
    runnable: { task: AgentTask; taskRun: AgentTaskRun } | undefined,
    error: unknown
  ): Promise<void> {
    if (!runnable) return;
    const [task, taskRun] = await Promise.all([
      this.#options.store.tasks.get(runnable.task.id),
      this.#options.store.tasks.getLatestRun(runnable.task.id),
    ]);
    if (!task || task.status !== 'running' || !taskRun || taskRun.id !== runnable.taskRun.id
      || taskRun.status !== 'running' || taskRun.ownerId !== this.#options.workerId) return;
    try {
      const failed = await this.#options.store.tasks.fail({
        taskId: task.id,
        expectedTaskVersion: task.version,
        taskRunId: taskRun.id,
        ownerId: this.#options.workerId,
        error: {
          code: error instanceof RuntimeError ? error.code : 'runtime_error',
          message: error instanceof Error ? error.message : 'Runtime execution failed.',
        },
        nowMs: this.#options.clock.nowMs(),
      });
      for (const event of taskFinishEvents(failed)) await this.#publish(event);
    } catch {
      // A terminal transaction or newer owner won the race.
    }
  }

  async #publish(event: Parameters<RuntimeEventPublisher['publish']>[0]): Promise<void> {
    try { await this.#options.publisher.publish(event); } catch { /* SessionView is authoritative. */ }
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
