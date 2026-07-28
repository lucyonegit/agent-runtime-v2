import { describe, expect, it, vi } from 'vitest';
import type { AgentTask, AgentTaskRun } from '../src/domain/index.js';
import { TaskExecutor } from '../src/orchestration/tasks/task-executor.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('TaskExecutor TaskRun identity', () => {
  it('deduplicates one TaskRun but replaces a still-pending older TaskRun', async () => {
    const task = {
      id: 'task_1',
      sessionId: 'session_1',
      status: 'running',
      version: 1,
    } as AgentTask;
    let latestRun = taskRun('task_run_1', 1);
    const executions: Array<{
      taskRunId: string;
      signal: AbortSignal;
      complete(): void;
    }> = [];
    const runTask = vi.fn((input: { taskRun: AgentTaskRun; signal?: AbortSignal }) => (
      new Promise<void>(resolve => {
        const signal = input.signal!;
        const execution = { taskRunId: input.taskRun.id, signal, complete: resolve };
        executions.push(execution);
        signal.addEventListener('abort', () => resolve(), { once: true });
      })
    ));
    const store = {
      tasks: {
        get: vi.fn(async () => task),
        getLatestRun: vi.fn(async () => latestRun),
      },
    } as unknown as AgentStore;
    const executor = new TaskExecutor({
      store,
      reactExecution: { runTask } as never,
      workerId: 'worker_1',
      publisher: { publish: vi.fn() },
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      recoveryIntervalMs: 60_000,
      clock: { nowMs: () => 100 },
    });

    const first = executor.startExecution(task.id);
    await vi.waitFor(() => expect(executions.map(item => item.taskRunId)).toEqual(['task_run_1']));

    const duplicate = executor.startExecution(task.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(executions.map(item => item.taskRunId)).toEqual(['task_run_1']);

    latestRun = taskRun('task_run_2', 2);
    const resumed = executor.startExecution(task.id);
    await vi.waitFor(() => expect(executions.map(item => item.taskRunId)).toEqual([
      'task_run_1',
      'task_run_2',
    ]));

    expect(executions[0]!.signal.aborted).toBe(true);
    expect(executions[0]!.signal.reason).toBe('task_run_superseded');
    expect(executions[1]!.signal.aborted).toBe(false);

    executions[1]!.complete();
    await Promise.all([first, duplicate, resumed]);
    expect(runTask).toHaveBeenCalledTimes(2);
  });

  it('aborts and joins only executions owned by the deleted Session', async () => {
    const tasks = new Map([
      ['task_1', task('task_1', 'session_1')],
      ['task_2', task('task_2', 'session_2')],
    ]);
    const runs = new Map([
      ['task_1', taskRunFor('task_run_1', 'task_1')],
      ['task_2', taskRunFor('task_run_2', 'task_2')],
    ]);
    const executions = new Map<string, { signal: AbortSignal; complete(): void }>();
    const executor = new TaskExecutor({
      store: {
        tasks: {
          get: vi.fn(async (taskId: string) => tasks.get(taskId)),
          getLatestRun: vi.fn(async (taskId: string) => runs.get(taskId)),
        },
      } as unknown as AgentStore,
      reactExecution: {
        runTask: vi.fn((input: { task: AgentTask; signal?: AbortSignal }) => (
          new Promise<void>(resolve => {
            const signal = input.signal!;
            executions.set(input.task.id, { signal, complete: resolve });
            signal.addEventListener('abort', () => resolve(), { once: true });
          })
        )),
      } as never,
      workerId: 'worker_1',
      publisher: { publish: vi.fn() },
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      recoveryIntervalMs: 60_000,
      terminationGraceMs: 100,
      clock: { nowMs: () => 100 },
    });

    const first = executor.startExecution('task_1');
    const second = executor.startExecution('task_2');
    await vi.waitFor(() => expect(executions.size).toBe(2));

    await executor.abortSessionExecutions('session_1');

    expect(executions.get('task_1')?.signal).toMatchObject({
      aborted: true,
      reason: 'session_deletion',
    });
    expect(executions.get('task_2')?.signal.aborted).toBe(false);
    executions.get('task_2')?.complete();
    await Promise.all([first, second]);
  });

  it('times out deletion safely when an execution ignores abort', async () => {
    const activeTask = task('task_1', 'session_1');
    const activeRun = taskRunFor('task_run_1', activeTask.id);
    let signal: AbortSignal | undefined;
    let complete!: () => void;
    const executor = new TaskExecutor({
      store: {
        tasks: {
          get: vi.fn(async () => activeTask),
          getLatestRun: vi.fn(async () => activeRun),
        },
      } as unknown as AgentStore,
      reactExecution: {
        runTask: vi.fn((input: { signal?: AbortSignal }) => new Promise<void>(resolve => {
          signal = input.signal;
          complete = resolve;
        })),
      } as never,
      workerId: 'worker_1',
      publisher: { publish: vi.fn() },
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      recoveryIntervalMs: 60_000,
      terminationGraceMs: 10,
      clock: { nowMs: () => 100 },
    });
    const running = executor.startExecution(activeTask.id);
    await vi.waitFor(() => expect(signal).toBeDefined());

    await expect(executor.abortSessionExecutions('session_1')).rejects.toMatchObject({
      code: 'execution_stop_timeout',
      retryable: true,
    });
    expect(signal).toMatchObject({ aborted: true, reason: 'session_deletion' });

    complete();
    await running;
  });

  it('keeps superseded executions tracked until Session deletion can join them', async () => {
    const activeTask = task('task_1', 'session_1');
    let latestRun = taskRunFor('task_run_1', activeTask.id);
    const signals = new Map<string, AbortSignal>();
    let completeSuperseded!: () => void;
    const executor = new TaskExecutor({
      store: {
        tasks: {
          get: vi.fn(async () => activeTask),
          getLatestRun: vi.fn(async () => latestRun),
        },
      } as unknown as AgentStore,
      reactExecution: {
        runTask: vi.fn((input: { taskRun: AgentTaskRun; signal?: AbortSignal }) => (
          new Promise<void>(resolve => {
            const signal = input.signal!;
            signals.set(input.taskRun.id, signal);
            if (input.taskRun.id === 'task_run_1') completeSuperseded = resolve;
            else signal.addEventListener('abort', () => resolve(), { once: true });
          })
        )),
      } as never,
      workerId: 'worker_1',
      publisher: { publish: vi.fn() },
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      recoveryIntervalMs: 60_000,
      terminationGraceMs: 10,
      clock: { nowMs: () => 100 },
    });

    const first = executor.startExecution(activeTask.id);
    await vi.waitFor(() => expect(signals.has('task_run_1')).toBe(true));
    latestRun = taskRunFor('task_run_2', activeTask.id);
    const second = executor.startExecution(activeTask.id);
    await vi.waitFor(() => expect(signals.has('task_run_2')).toBe(true));

    await expect(executor.abortSessionExecutions(activeTask.sessionId)).rejects.toMatchObject({
      code: 'execution_stop_timeout',
    });
    expect(signals.get('task_run_1')).toMatchObject({
      aborted: true,
      reason: 'task_run_superseded',
    });
    expect(signals.get('task_run_2')).toMatchObject({
      aborted: true,
      reason: 'session_deletion',
    });

    completeSuperseded();
    await Promise.all([first, second]);
  });
});

function taskRun(id: string, runNo: number): AgentTaskRun {
  return {
    id,
    taskId: 'task_1',
    runNo,
    trigger: runNo === 1 ? 'initial' : 'manual_resume',
    status: 'running',
    ownerId: 'worker_1',
    ownershipExpiresAtMs: 1_000,
    startedAtMs: 10 * runNo,
    updatedAtMs: 10 * runNo,
  };
}

function task(id: string, sessionId: string): AgentTask {
  return {
    id,
    sessionId,
    goalMessageId: `message_${id}`,
    status: 'running',
    version: 1,
    createdAtMs: 10,
    updatedAtMs: 20,
    startedAtMs: 20,
  };
}

function taskRunFor(id: string, taskId: string): AgentTaskRun {
  return {
    ...taskRun(id, 1),
    taskId,
  };
}
