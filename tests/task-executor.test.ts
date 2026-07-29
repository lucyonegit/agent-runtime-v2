import { describe, expect, it, vi } from 'vitest';
import type { AgentTask, AgentTaskRun } from '../src/domain/index.js';
import { TaskExecutor } from '../src/orchestration/tasks/task-executor.js';
import { RuntimeError } from '../src/runtime/errors/runtime-error.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('TaskExecutor TaskRun identity', () => {
  it('deduplicates one TaskRun but replaces a still-pending older TaskRun', async () => {
    const task = {
      id: 'task_1',
      sessionId: 'session_1',
      status: 'running',
      version: 1,
    } as AgentTask;
    const runs = new Map<string, AgentTaskRun>([
      ['task_run_1', taskRun('task_run_1', 1)],
    ]);
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
        getRun: vi.fn(async (taskRunId: string) => runs.get(taskRunId)),
      },
    } as unknown as AgentStore;
    const executor = new TaskExecutor({
      store,
      reactExecution: { runTask } as never,
      workerId: 'worker_1',
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      clock: { nowMs: () => 100 },
    });

    const first = executor.execute({ taskId: task.id, taskRunId: 'task_run_1' });
    await vi.waitFor(() => expect(executions.map(item => item.taskRunId)).toEqual(['task_run_1']));

    const duplicate = executor.execute({ taskId: task.id, taskRunId: 'task_run_1' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(executions.map(item => item.taskRunId)).toEqual(['task_run_1']);

    runs.set('task_run_2', taskRun('task_run_2', 2));
    const resumed = executor.execute({ taskId: task.id, taskRunId: 'task_run_2' });
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

  it('rejects a command whose Task and TaskRun identities do not match', async () => {
    const activeTask = task('task_1', 'session_1');
    const mismatchedRun = taskRunFor('task_run_2', 'task_2');
    const runTask = vi.fn();
    const getRun = vi.fn(async () => mismatchedRun);
    const executor = new TaskExecutor({
      store: {
        tasks: {
          get: vi.fn(async () => activeTask),
          getRun,
        },
      } as unknown as AgentStore,
      reactExecution: { runTask } as never,
      workerId: 'worker_1',
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      clock: { nowMs: () => 100 },
    });

    await expect(executor.execute({
      taskId: activeTask.id,
      taskRunId: mismatchedRun.id,
    })).rejects.toMatchObject({ code: 'ownership_lost' });

    expect(getRun).toHaveBeenCalledWith(mismatchedRun.id);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('propagates infrastructure failures without terminalizing durable Task state', async () => {
    const activeTask = task('task_1', 'session_1');
    const activeRun = taskRunFor('task_run_1', activeTask.id);
    const failure = new Error('model transport unavailable');
    const fail = vi.fn();
    const executor = new TaskExecutor({
      store: {
        tasks: {
          get: vi.fn(async () => activeTask),
          getRun: vi.fn(async () => activeRun),
          fail,
        },
      } as unknown as AgentStore,
      reactExecution: { runTask: vi.fn(async () => { throw failure; }) } as never,
      workerId: 'worker_1',
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      clock: { nowMs: () => 100 },
    });

    await expect(executor.execute({
      taskId: activeTask.id,
      taskRunId: activeRun.id,
    })).rejects.toBe(failure);

    expect(fail).not.toHaveBeenCalled();
  });

  it('treats ownership loss as local execution termination rather than Task failure', async () => {
    const activeTask = task('task_1', 'session_1');
    const activeRun = taskRunFor('task_run_1', activeTask.id);
    const fail = vi.fn();
    const executor = new TaskExecutor({
      store: {
        tasks: {
          get: vi.fn(async () => activeTask),
          getRun: vi.fn(async () => activeRun),
          fail,
        },
      } as unknown as AgentStore,
      reactExecution: {
        runTask: vi.fn(async () => {
          throw new RuntimeError('ownership_lost', 'lease expired');
        }),
      } as never,
      workerId: 'worker_1',
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      clock: { nowMs: () => 100 },
    });

    await expect(executor.execute({
      taskId: activeTask.id,
      taskRunId: activeRun.id,
    })).resolves.toBeUndefined();

    expect(fail).not.toHaveBeenCalled();
  });

  it('aborts and joins only executions owned by the deleted Session', async () => {
    const tasks = new Map([
      ['task_1', task('task_1', 'session_1')],
      ['task_2', task('task_2', 'session_2')],
    ]);
    const runs = new Map([
      ['task_run_1', taskRunFor('task_run_1', 'task_1')],
      ['task_run_2', taskRunFor('task_run_2', 'task_2')],
    ]);
    const executions = new Map<string, { signal: AbortSignal; complete(): void }>();
    const executor = new TaskExecutor({
      store: {
        tasks: {
          get: vi.fn(async (taskId: string) => tasks.get(taskId)),
          getRun: vi.fn(async (taskRunId: string) => runs.get(taskRunId)),
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
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      terminationGraceMs: 100,
      clock: { nowMs: () => 100 },
    });

    const first = executor.execute({ taskId: 'task_1', taskRunId: 'task_run_1' });
    const second = executor.execute({ taskId: 'task_2', taskRunId: 'task_run_2' });
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
          getRun: vi.fn(async () => activeRun),
        },
      } as unknown as AgentStore,
      reactExecution: {
        runTask: vi.fn((input: { signal?: AbortSignal }) => new Promise<void>(resolve => {
          signal = input.signal;
          complete = resolve;
        })),
      } as never,
      workerId: 'worker_1',
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      terminationGraceMs: 10,
      clock: { nowMs: () => 100 },
    });
    const running = executor.execute({ taskId: activeTask.id, taskRunId: activeRun.id });
    await vi.waitFor(() => expect(signal).toBeDefined());

    await expect(executor.abortSessionExecutions('session_1')).rejects.toMatchObject({
      code: 'execution_stop_timeout',
      retryable: true,
    });
    expect(signal).toMatchObject({ aborted: true, reason: 'session_deletion' });

    complete();
    await running;
  });

  it('bounds shutdown and stops lease renewal when an execution ignores abort', async () => {
    const activeTask = task('task_1', 'session_1');
    const activeRun = taskRunFor('task_run_1', activeTask.id);
    const renewRunOwnership = vi.fn(async () => undefined);
    let signal: AbortSignal | undefined;
    let complete!: () => void;
    const executor = new TaskExecutor({
      store: {
        tasks: {
          get: vi.fn(async () => activeTask),
          getRun: vi.fn(async () => activeRun),
          renewRunOwnership,
        },
      } as unknown as AgentStore,
      reactExecution: {
        runTask: vi.fn((input: { signal?: AbortSignal }) => new Promise<void>(resolve => {
          signal = input.signal;
          complete = resolve;
        })),
      } as never,
      workerId: 'worker_1',
      ownershipTimeoutMs: 1_000,
      ownershipRefreshMs: 20,
      terminationGraceMs: 10,
      clock: { nowMs: () => 100 },
    });
    const running = executor.execute({ taskId: activeTask.id, taskRunId: activeRun.id });
    await vi.waitFor(() => expect(signal).toBeDefined());

    await expect(executor.shutdown()).resolves.toBeUndefined();
    expect(signal).toMatchObject({ aborted: true, reason: 'runtime_shutdown' });
    const renewalCountAtShutdown = renewRunOwnership.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(renewRunOwnership).toHaveBeenCalledTimes(renewalCountAtShutdown);

    complete();
    await running;
  });

  it('keeps superseded executions tracked until Session deletion can join them', async () => {
    const activeTask = task('task_1', 'session_1');
    const runs = new Map<string, AgentTaskRun>([
      ['task_run_1', taskRunFor('task_run_1', activeTask.id)],
    ]);
    const signals = new Map<string, AbortSignal>();
    let completeSuperseded!: () => void;
    const executor = new TaskExecutor({
      store: {
        tasks: {
          get: vi.fn(async () => activeTask),
          getRun: vi.fn(async (taskRunId: string) => runs.get(taskRunId)),
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
      ownershipTimeoutMs: 30_000,
      ownershipRefreshMs: 10_000,
      terminationGraceMs: 10,
      clock: { nowMs: () => 100 },
    });

    const first = executor.execute({ taskId: activeTask.id, taskRunId: 'task_run_1' });
    await vi.waitFor(() => expect(signals.has('task_run_1')).toBe(true));
    runs.set('task_run_2', taskRunFor('task_run_2', activeTask.id));
    const second = executor.execute({ taskId: activeTask.id, taskRunId: 'task_run_2' });
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
