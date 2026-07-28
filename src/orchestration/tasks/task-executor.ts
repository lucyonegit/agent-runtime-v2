import { DEFAULT_EXECUTION_CONFIG } from '../../config/runtime-config.js';
import type { AgentTask, AgentTaskRun } from '../../domain/index.js';
import type { ReActExecution } from '../../runtime/execution/react-execution.js';
import { RuntimeError } from '../../runtime/errors/runtime-error.js';
import type { RuntimeEventPublisher } from '../../runtime/events/runtime-event-writer.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { ExecutionOwnershipService } from './shared/execution-ownership.service.js';
import { InterruptedTaskScanner } from './shared/interrupted-task-scanner.js';

export interface TaskExecutorPort {
  start(): Promise<void>;
  startExecution(taskId: string): Promise<void>;
  abortExecution(taskId: string): void;
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
  clock?: { nowMs(): number };
}

/** Owns process-local scheduling; durable lifecycle changes stay in stores/flows. */
export class TaskExecutor implements TaskExecutorPort {
  readonly #activeExecutions = new Map<string, {
    taskRunId: string;
    controller: AbortController;
    completion: Promise<void>;
  }>();
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
      clock: { nowMs: () => Date.now() },
      ...options,
    };
    if (this.#options.ownershipRefreshMs >= this.#options.ownershipTimeoutMs) {
      throw new RangeError('ownershipRefreshMs must be shorter than ownershipTimeoutMs.');
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
      taskRunId: selected.taskRun.id,
      controller: new AbortController(),
      completion: Promise.resolve(),
    };
    this.#activeExecutions.set(taskId, execution);
    existing?.controller.abort('task_run_superseded');
    execution.completion = this.#runOwnedTask(
      taskId,
      selected.taskRun.id,
      execution.controller.signal
    ).finally(() => {
      if (this.#activeExecutions.get(taskId) === execution) this.#activeExecutions.delete(taskId);
    });
    return execution.completion;
  }

  abortExecution(taskId: string): void {
    this.#activeExecutions.get(taskId)?.controller.abort('task_cancelled');
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    await this.#interruptedTaskScanner.stop();
    const active = [...this.#activeExecutions.values()];
    for (const execution of active) execution.controller.abort('runtime_shutdown');
    await Promise.allSettled(active.map(execution => execution.completion));
  }

  async #runOwnedTask(
    taskId: string,
    expectedTaskRunId: string,
    signal: AbortSignal
  ): Promise<void> {
    let runnable: { task: AgentTask; taskRun: AgentTaskRun } | undefined;
    let stopRefreshing: () => void = () => undefined;
    try {
      runnable = await this.#loadRunnableTask(taskId, expectedTaskRunId);
      stopRefreshing = this.#executionOwnership.startRefreshing(taskId, runnable.taskRun.id);
      await this.#options.reactExecution.runTask({ ...runnable, signal });
    } catch (error) {
      if (!(error instanceof RuntimeError && ['ownership_lost', 'aborted'].includes(error.code))) {
        await this.#failTaskIfStillOwned(runnable, error);
      }
    } finally {
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
      await this.#publish({ type: 'task.upserted', sessionId: failed.task.sessionId, task: failed.task });
      if (failed.taskRun) {
        await this.#publish({
          type: 'task_run.upserted',
          sessionId: failed.task.sessionId,
          taskRun: failed.taskRun,
        });
      }
      if (failed.planCleared) {
        await this.#publish({
          type: 'plan.cleared',
          sessionId: failed.task.sessionId,
          taskId: failed.task.id,
        });
      }
    } catch {
      // A terminal transaction or newer owner won the race.
    }
  }

  async #publish(event: Parameters<RuntimeEventPublisher['publish']>[0]): Promise<void> {
    try { await this.#options.publisher.publish(event); } catch { /* SessionView is authoritative. */ }
  }
}
