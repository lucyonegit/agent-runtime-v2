import { describe, expect, it, vi } from 'vitest';
import type { AgentSession, AgentTask } from '../src/domain/index.js';
import { RetryTaskFlow } from '../src/orchestration/tasks/flows/retry-task.flow.js';
import type { TaskExecutionDispatcher } from '../src/orchestration/tasks/shared/task-execution-dispatcher.js';
import type { TaskEventPublisher } from '../src/orchestration/tasks/shared/task-event-publisher.js';
import type { TaskRunStarter } from '../src/orchestration/tasks/shared/task-run-starter.js';
import { RuntimeError } from '../src/runtime/errors/runtime-error.js';
import { AgentStoreError, type AgentStore } from '../src/storage/agent-store.js';

describe('RetryTaskFlow', () => {
  it('starts a committed retry that was not started before the response was lost', async () => {
    const source = taskFixture({ status: 'failed', completedAtMs: 300 });
    const replay = taskFixture({
      id: 'task_retry',
      retryOfTaskId: source.id,
      clientRequestId: 'request_1',
      status: 'created',
    });
    const started = taskFixture({ ...replay, status: 'running', version: 1 });
    const createRetry = vi.fn(async () => {
      throw new AgentStoreError('CLIENT_REQUEST_CONFLICT', 'request already committed');
    });
    const start = vi.fn(async () => ({ task: started, taskRun: {} }));
    const dispatch = vi.fn();
    const flow = new RetryTaskFlow(
      storeFixture({ source, replay, session: sessionFixture(), createRetry }),
      { nowMs: () => 1_000 },
      () => 'task_generated',
      { start } as unknown as TaskRunStarter,
      { publishTask: vi.fn(async () => undefined) } as unknown as TaskEventPublisher,
      { dispatch } as unknown as TaskExecutionDispatcher
    );

    await expect(flow.execute({
      sourceTaskId: source.id,
      clientRequestId: 'request_1',
    })).resolves.toMatchObject({ task: started });

    expect(start).toHaveBeenCalledWith(replay, 'initial');
    expect(dispatch).toHaveBeenCalledWith(started.id);
  });

  it('returns an already-started retry without starting or dispatching it again', async () => {
    const source = taskFixture({ status: 'failed', completedAtMs: 300 });
    const replay = taskFixture({
      id: 'task_retry',
      retryOfTaskId: source.id,
      clientRequestId: 'request_1',
      status: 'running',
      version: 1,
    });
    const session = sessionFixture();
    const createRetry = vi.fn(async () => {
      throw new AgentStoreError('CLIENT_REQUEST_CONFLICT', 'request already committed');
    });
    const start = vi.fn();
    const publishTask = vi.fn(async () => undefined);
    const dispatch = vi.fn();
    const flow = new RetryTaskFlow(
      storeFixture({ source, replay, session, createRetry }),
      { nowMs: () => 1_000 },
      () => 'task_generated',
      { start } as unknown as TaskRunStarter,
      { publishTask } as unknown as TaskEventPublisher,
      { dispatch } as unknown as TaskExecutionDispatcher
    );

    await expect(flow.execute({
      sourceTaskId: source.id,
      clientRequestId: 'request_1',
    })).resolves.toEqual({ session, task: replay });

    expect(publishTask).toHaveBeenCalledWith(replay);
    expect(start).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a retry key that belongs to a different operation', async () => {
    const source = taskFixture({ status: 'completed', completedAtMs: 300 });
    const replay = taskFixture({
      id: 'task_other_retry',
      retryOfTaskId: 'task_other',
      clientRequestId: 'request_1',
      status: 'running',
    });
    const createRetry = vi.fn(async () => {
      throw new AgentStoreError('CLIENT_REQUEST_CONFLICT', 'request already committed');
    });
    const flow = new RetryTaskFlow(
      storeFixture({ source, replay, session: sessionFixture(), createRetry }),
      { nowMs: () => 1_000 },
      () => 'task_generated',
      { start: vi.fn() } as unknown as TaskRunStarter,
      { publishTask: vi.fn() } as unknown as TaskEventPublisher,
      { dispatch: vi.fn() } as unknown as TaskExecutionDispatcher
    );

    const error = await flow.execute({
      sourceTaskId: source.id,
      clientRequestId: 'request_1',
    }).catch(candidate => candidate);

    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toMatchObject({ code: 'idempotency_conflict' });
  });
});

function storeFixture(input: {
  source: AgentTask;
  replay: AgentTask;
  session: AgentSession;
  createRetry: ReturnType<typeof vi.fn>;
}): AgentStore {
  return {
    sessions: {
      get: vi.fn(async () => input.session),
    },
    tasks: {
      get: vi.fn(async () => input.source),
      getByClientRequestId: vi.fn(async () => input.replay),
      createRetry: input.createRetry,
    },
  } as unknown as AgentStore;
}

function sessionFixture(): AgentSession {
  return {
    id: 'session_1',
    status: 'active',
    version: 1,
    createdAtMs: 100,
    updatedAtMs: 200,
  };
}

function taskFixture(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task_source',
    sessionId: 'session_1',
    goalMessageId: 'message_goal',
    status: 'running',
    version: 0,
    createdAtMs: 100,
    updatedAtMs: 200,
    ...overrides,
  };
}
