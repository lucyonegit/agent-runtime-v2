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
