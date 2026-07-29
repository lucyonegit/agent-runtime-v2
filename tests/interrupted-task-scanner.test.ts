import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../src/domain/index.js';
import { InterruptedTaskScanner } from '../src/orchestration/tasks/shared/interrupted-task-scanner.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('InterruptedTaskScanner startup reconciliation', () => {
  afterEach(() => vi.useRealTimers());

  it('drains the startup backlog in batches without scheduling another scan', async () => {
    vi.useFakeTimers();
    const abandoned = task({ status: 'created', version: 1 });
    const failed = task({ status: 'failed', version: 2 });
    const listInterrupted = vi.fn()
      .mockResolvedValueOnce([{ task: abandoned, sideEffectingToolCalls: [] }])
      .mockResolvedValueOnce([]);
    const reconcileInterrupted = vi.fn(async () => ({
      task: failed,
      toolCalls: [],
      toolRuns: [],
      userInputRequests: [],
      planCleared: false,
    }));
    const publish = vi.fn(async () => undefined);
    const scanner = new InterruptedTaskScanner({
      store: {
        models: { abandonStartedCalls: vi.fn(async () => []) },
        execution: { listExpiredUserInputRequests: vi.fn(async () => []) },
        tasks: { listInterrupted, reconcileInterrupted },
      } as unknown as AgentStore,
      publisher: { publish },
      createdTaskGraceMs: 5_000,
      batchSize: 1,
      clock: { nowMs: () => 10_000 },
    });

    await scanner.scanOnce();

    expect(listInterrupted).toHaveBeenCalledTimes(2);
    expect(listInterrupted).toHaveBeenNthCalledWith(1, {
      nowMs: 10_000,
      createdBeforeMs: 5_000,
      limit: 1,
    });
    expect(reconcileInterrupted).toHaveBeenCalledWith({
      taskId: abandoned.id,
      expectedTaskVersion: abandoned.version,
      confirmationRequests: [],
      nowMs: 10_000,
    });
    expect(publish).toHaveBeenCalledWith({
      type: 'task.upserted',
      sessionId: failed.sessionId,
      task: failed,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allocates a complete side-effect confirmation request before persistence', async () => {
    const interrupted = task({ status: 'running', version: 1 });
    const waiting = task({ status: 'waiting_for_user', version: 2 });
    const listInterrupted = vi.fn()
      .mockResolvedValueOnce([{
        task: interrupted,
        sideEffectingToolCalls: [{ id: 'tool_call_1', toolName: 'run_shell' }],
      }])
      .mockResolvedValueOnce([]);
    const reconcileInterrupted = vi.fn(async (input: {
      confirmationRequests: Array<{ requestId: string }>;
    }) => ({
      task: waiting,
      toolCalls: [],
      toolRuns: [],
      userInputRequests: [{
        id: input.confirmationRequests[0]!.requestId,
        kind: 'side_effect_confirmation',
      }],
      planCleared: false,
    }));
    const scanner = new InterruptedTaskScanner({
      store: {
        models: { abandonStartedCalls: vi.fn(async () => []) },
        execution: { listExpiredUserInputRequests: vi.fn(async () => []) },
        tasks: { listInterrupted, reconcileInterrupted },
      } as unknown as AgentStore,
      publisher: { publish: vi.fn(async () => undefined) },
      createdTaskGraceMs: 5_000,
      batchSize: 1,
      clock: { nowMs: () => 10_000 },
    });

    await scanner.scanOnce();

    expect(reconcileInterrupted).toHaveBeenCalledWith(expect.objectContaining({
      taskId: interrupted.id,
      confirmationRequests: [expect.objectContaining({
        toolCallId: 'tool_call_1',
        requestId: expect.stringMatching(/^input_/),
        title: 'Confirm operation outcome',
        prompt: expect.stringContaining('run_shell'),
        inputSchema: expect.objectContaining({ type: 'single_choice' }),
      })],
    }));
  });

  it('terminalizes expired input without dispatching another TaskRun', async () => {
    const failed = task({ status: 'failed', version: 2 });
    const expireUserInput = vi.fn(async () => ({
      request: { id: 'input_1' },
      resultMessage: { id: 'message_expired' },
      task: failed,
      taskRun: { id: 'task_run_1' },
      toolCall: { id: 'tool_call_1' },
      toolCalls: [{ id: 'tool_call_1' }],
      toolRuns: [],
      userInputRequests: [{ id: 'input_1' }],
      planCleared: false,
    }));
    const publish = vi.fn(async () => undefined);
    const scanner = new InterruptedTaskScanner({
      store: {
        models: { abandonStartedCalls: vi.fn(async () => []) },
        execution: {
          listExpiredUserInputRequests: vi.fn(async () => [{ id: 'input_1', version: 0 }]),
          expireUserInput,
        },
        tasks: { listInterrupted: vi.fn(async () => []) },
      } as unknown as AgentStore,
      publisher: { publish },
      createdTaskGraceMs: 5_000,
      batchSize: 2,
      clock: { nowMs: () => 10_000 },
    });

    await scanner.scanOnce();

    expect(expireUserInput).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'input_1',
      expectedVersion: 0,
      nowMs: 10_000,
    }));
    expect(publish).toHaveBeenCalledWith({
      type: 'task.upserted',
      sessionId: failed.sessionId,
      task: failed,
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
