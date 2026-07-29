import { describe, expect, it, vi } from 'vitest';
import type { AgentTask, AgentTaskRun } from '../src/domain/index.js';
import { ResumeTaskFlow } from '../src/orchestration/tasks/flows/resume-task.flow.js';
import type { TaskExecutionDispatcher } from '../src/orchestration/tasks/shared/task-execution-dispatcher.js';
import type { TaskRunStarter } from '../src/orchestration/tasks/shared/task-run-starter.js';
import { RuntimeError } from '../src/runtime/errors/runtime-error.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('ResumeTaskFlow', () => {
  it('starts one safe manual-resume TaskRun and dispatches its exact identity', async () => {
    const recoverable = task({ status: 'recovery_required', version: 2 });
    const running = task({ status: 'running', version: 3 });
    const taskRun = run();
    const start = vi.fn(async () => ({ task: running, taskRun }));
    const dispatch = vi.fn();
    const flow = new ResumeTaskFlow(
      { tasks: { get: vi.fn(async () => recoverable) } } as unknown as AgentStore,
      { start } as unknown as TaskRunStarter,
      { dispatch } as unknown as TaskExecutionDispatcher
    );

    await expect(flow.execute(recoverable.id, recoverable.version)).resolves.toBe(running);

    expect(start).toHaveBeenCalledWith(recoverable, 'manual_resume');
    expect(dispatch).toHaveBeenCalledWith({ taskId: running.id, taskRunId: taskRun.id });
  });

  it('does not dispatch when the atomic resume gate rejects unsafe tool state', async () => {
    const recoverable = task({ status: 'recovery_required', version: 2 });
    const failure = new RuntimeError(
      'tool_state_unknown',
      'The latest checkpoint cannot be replayed safely.'
    );
    const dispatch = vi.fn();
    const flow = new ResumeTaskFlow(
      { tasks: { get: vi.fn(async () => recoverable) } } as unknown as AgentStore,
      { start: vi.fn(async () => { throw failure; }) } as unknown as TaskRunStarter,
      { dispatch } as unknown as TaskExecutionDispatcher
    );

    await expect(flow.execute(recoverable.id, recoverable.version)).rejects.toBe(failure);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

function task(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: 'task_1',
    sessionId: 'session_1',
    goalMessageId: 'goal_1',
    status: 'recovery_required',
    version: 2,
    createdAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  };
}

function run(): AgentTaskRun {
  return {
    id: 'task_run_2',
    taskId: 'task_1',
    runNo: 2,
    trigger: 'manual_resume',
    status: 'running',
    ownerId: 'worker_1',
    ownershipExpiresAtMs: 1_000,
    startedAtMs: 3,
    updatedAtMs: 3,
  };
}
