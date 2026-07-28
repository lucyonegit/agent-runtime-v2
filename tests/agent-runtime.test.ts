import { describe, expect, it, vi } from 'vitest';
import { AGENT_REQUEST_LIMITS, type AgentTask } from '../src/domain/index.js';
import { AgentRuntime } from '../src/orchestration/agent-runtime.js';
import type { TaskManagerPort } from '../src/orchestration/tasks/task-manager.js';
import { AgentStoreError, type AgentStore } from '../src/storage/agent-store.js';

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

  it('rejects oversized public text fields before persistence or execution', async () => {
    const tasks = taskManager();
    const create = vi.fn();
    const runtime = createRuntime({ sessions: { create } } as unknown as AgentStore, tasks);

    await expect(runtime.createSession({
      title: 'x'.repeat(AGENT_REQUEST_LIMITS.sessionTitleCharacters + 1),
    })).rejects.toThrow('title must not exceed');
    await expect(runtime.createSession({
      clientRequestId: 'x'.repeat(AGENT_REQUEST_LIMITS.idempotencyKeyCharacters + 1),
    })).rejects.toThrow('clientRequestId must not exceed');
    await expect(runtime.createTask({
      sessionId: 'session_1',
      message: 'x'.repeat(AGENT_REQUEST_LIMITS.taskMessageCharacters + 1),
      clientRequestId: 'request_1',
    })).rejects.toThrow('message must not exceed');
    await expect(runtime.retryTask({
      sourceTaskId: 'task_1',
      clientRequestId: 'x'.repeat(AGENT_REQUEST_LIMITS.idempotencyKeyCharacters + 1),
    })).rejects.toThrow('clientRequestId must not exceed');

    expect(create).not.toHaveBeenCalled();
    expect(tasks.createTask).not.toHaveBeenCalled();
    expect(tasks.retryTask).not.toHaveBeenCalled();
  });

  it('replays client-owned Session creation and rejects changed payloads', async () => {
    let stored: ReturnType<typeof sessionFixture> | undefined;
    const create = vi.fn(async (input: { id: string; title?: string; nowMs: number }) => {
      if (stored) {
        throw new AgentStoreError('SESSION_ALREADY_EXISTS', 'session already committed');
      }
      stored = sessionFixture({
        id: input.id,
        title: input.title,
        createdAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
      });
      return stored;
    });
    const get = vi.fn(async (sessionId: string) => (
      stored?.id === sessionId ? stored : undefined
    ));
    const runtime = createRuntime({
      sessions: { create, get },
    } as unknown as AgentStore, taskManager());

    const first = await runtime.createSession({
      title: 'Durable intent',
      clientRequestId: 'session_request_1',
    });
    const replay = await runtime.createSession({
      title: 'Durable intent',
      clientRequestId: 'session_request_1',
    });

    expect(replay).toEqual(first);
    expect(create.mock.calls[0]?.[0].id).toBe(create.mock.calls[1]?.[0].id);
    await expect(runtime.createSession({
      title: 'Changed title',
      clientRequestId: 'session_request_1',
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('fences execution and finishes external cleanup before deleting durable state', async () => {
    const order: string[] = [];
    const tasks = taskManager();
    vi.mocked(tasks.prepareSessionDeletion).mockImplementation(async () => {
      order.push('fence');
      return true;
    });
    const finalizeDeletion = vi.fn(async () => {
      order.push('database');
      return true;
    });
    const runtime = new AgentRuntime({
      store: { sessions: { finalizeDeletion } } as unknown as AgentStore,
      tasks,
      beforeDeleteSession: async () => { order.push('processes'); },
      removeSessionWorkspace: async () => { order.push('workspace'); },
      clock: { nowMs: () => 1_000 },
      ids: { sessionId: () => 'session_generated' },
    });

    await expect(runtime.deleteSession('session_1')).resolves.toBe(true);

    expect(order).toEqual(['fence', 'processes', 'workspace', 'database']);
    expect(finalizeDeletion).toHaveBeenCalledWith('session_1');
  });

  it('retries idempotent external cleanup even when durable state is already absent', async () => {
    const tasks = taskManager();
    vi.mocked(tasks.prepareSessionDeletion).mockResolvedValue(false);
    const removeSessionWorkspace = vi.fn(async () => undefined);
    const finalizeDeletion = vi.fn(async () => false);
    const runtime = new AgentRuntime({
      store: { sessions: { finalizeDeletion } } as unknown as AgentStore,
      tasks,
      beforeDeleteSession: vi.fn(async () => undefined),
      removeSessionWorkspace,
    });

    await expect(runtime.deleteSession('session_missing')).resolves.toBe(false);

    expect(removeSessionWorkspace).toHaveBeenCalledWith('session_missing');
    expect(finalizeDeletion).toHaveBeenCalledWith('session_missing');
  });

  it('keeps the durable tombstone when workspace cleanup fails', async () => {
    const tasks = taskManager();
    vi.mocked(tasks.prepareSessionDeletion).mockResolvedValue(true);
    const finalizeDeletion = vi.fn(async () => true);
    const runtime = new AgentRuntime({
      store: { sessions: { finalizeDeletion } } as unknown as AgentStore,
      tasks,
      removeSessionWorkspace: vi.fn(async () => {
        throw new Error('workspace busy');
      }),
    });

    await expect(runtime.deleteSession('session_1')).rejects.toThrow('workspace busy');
    expect(finalizeDeletion).not.toHaveBeenCalled();
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
    prepareSessionDeletion: vi.fn(async () => false),
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

function sessionFixture(overrides: Partial<{
  id: string;
  title?: string;
  status: 'active' | 'archived';
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}> = {}) {
  return {
    id: 'session_1',
    status: 'active' as const,
    version: 0,
    createdAtMs: 100,
    updatedAtMs: 100,
    ...overrides,
  };
}
