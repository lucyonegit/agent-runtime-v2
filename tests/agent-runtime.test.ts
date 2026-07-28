import { describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../src/domain/index.js';
import { AgentRuntime } from '../src/orchestration/agent-runtime.js';
import type { TaskManagerPort } from '../src/orchestration/tasks/task-manager.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('AgentRuntime application facade', () => {
  it('delegates process startup and shutdown to TaskManager', async () => {
    const tasks = taskManager();
    const runtime = createRuntime({} as AgentStore, tasks);

    await runtime.start();
    await runtime.stop();

    expect(tasks.start).toHaveBeenCalledOnce();
    expect(tasks.shutdown).toHaveBeenCalledOnce();
  });

  it('delegates Task commands without knowing execution or persistence details', async () => {
    const tasks = taskManager();
    const cancelled = taskFixture({ status: 'cancelled', version: 2, completedAtMs: 1_000 });
    vi.mocked(tasks.cancelTask).mockResolvedValue(cancelled);
    const runtime = createRuntime({} as AgentStore, tasks);

    await expect(runtime.cancelTask('task_1', 1)).resolves.toBe(cancelled);

    expect(tasks.cancelTask).toHaveBeenCalledWith('task_1', 1);
  });
});

function createRuntime(store: AgentStore, tasks: TaskManagerPort): AgentRuntime {
  return new AgentRuntime({
    store,
    tasks,
    clock: { nowMs: () => 1_000 },
    ids: { sessionId: () => 'session_generated' },
  });
}

function taskManager(): TaskManagerPort {
  return {
    start: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    createTask: vi.fn<TaskManagerPort['createTask']>(),
    cancelTask: vi.fn<TaskManagerPort['cancelTask']>(),
    retryTask: vi.fn<TaskManagerPort['retryTask']>(),
    continueAsNewTask: vi.fn<TaskManagerPort['continueAsNewTask']>(),
    resumeTask: vi.fn<TaskManagerPort['resumeTask']>(),
    answerUserInputRequest: vi.fn<TaskManagerPort['answerUserInputRequest']>(),
  };
}

function taskFixture(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task_1',
    sessionId: 'session_1',
    goalMessageId: 'message_goal_1',
    status: 'running',
    version: 1,
    createdAtMs: 100,
    updatedAtMs: 200,
    startedAtMs: 150,
    ...overrides,
  };
}
