import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../src/domain/index.js';
import { InterruptedTaskScanner } from '../src/orchestration/tasks/shared/interrupted-task-scanner.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('InterruptedTaskScanner startup recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('drains the startup backlog in batches without scheduling another scan', async () => {
    vi.useFakeTimers();
    const abandoned = task({ status: 'created', version: 1 });
    const recovered = task({ status: 'recovery_required', version: 2 });
    const listNeedingRecovery = vi.fn()
      .mockResolvedValueOnce([{ task: abandoned }])
      .mockResolvedValueOnce([]);
    const markRecoveryRequired = vi.fn(async () => ({
      task: recovered,
      toolCalls: [],
      toolRuns: [],
    }));
    const publish = vi.fn(async () => undefined);
    const scanner = new InterruptedTaskScanner({
      store: {
        models: { abandonStartedCalls: vi.fn(async () => []) },
        execution: { listExpiredUserInputRequests: vi.fn(async () => []) },
        tasks: { listNeedingRecovery, markRecoveryRequired },
      } as unknown as AgentStore,
      publisher: { publish },
      createdTaskGraceMs: 5_000,
      batchSize: 1,
      clock: { nowMs: () => 10_000 },
      ownerId: 'worker_1',
      ownershipTimeoutMs: 30_000,
      onTaskReady: vi.fn(),
    });

    await scanner.scanOnce();

    expect(listNeedingRecovery).toHaveBeenCalledTimes(2);
    expect(listNeedingRecovery).toHaveBeenNthCalledWith(1, {
      nowMs: 10_000,
      createdBeforeMs: 5_000,
      limit: 1,
    });
    expect(markRecoveryRequired).toHaveBeenCalledWith({
      taskId: abandoned.id,
      expectedTaskVersion: abandoned.version,
      nowMs: 10_000,
    });
    expect(publish).toHaveBeenCalledWith({
      type: 'task.upserted',
      sessionId: recovered.sessionId,
      task: recovered,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands an expired-input resume to execution with its committed TaskRun id', async () => {
    const resumed = task({ status: 'running', version: 2 });
    const onTaskReady = vi.fn();
    const scanner = new InterruptedTaskScanner({
      store: {
        models: { abandonStartedCalls: vi.fn(async () => []) },
        execution: {
          listExpiredUserInputRequests: vi.fn(async () => [{ id: 'input_1', version: 0 }]),
          expireUserInput: vi.fn(async () => ({
            request: { id: 'input_1' },
            resultMessage: { id: 'message_expired' },
            task: resumed,
            taskRun: { id: 'task_run_resumed' },
            toolCall: { id: 'tool_call_1' },
            shouldResume: true,
          })),
        },
        tasks: { listNeedingRecovery: vi.fn(async () => []) },
      } as unknown as AgentStore,
      publisher: { publish: vi.fn(async () => undefined) },
      createdTaskGraceMs: 5_000,
      batchSize: 2,
      clock: { nowMs: () => 10_000 },
      ownerId: 'worker_1',
      ownershipTimeoutMs: 30_000,
      onTaskReady,
    });

    await scanner.scanOnce();

    expect(onTaskReady).toHaveBeenCalledWith({
      taskId: resumed.id,
      taskRunId: 'task_run_resumed',
    });
  });
});

function task(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: 'task_1',
    sessionId: 'session_1',
    goalMessageId: 'message_goal_1',
    status: 'created',
    version: 1,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}
