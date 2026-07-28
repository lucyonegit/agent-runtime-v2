import { describe, expect, it, vi } from 'vitest';
import type { AgentRealtimeEvent } from '../src/domain/index.js';
import { TaskManager } from '../src/orchestration/tasks/task-manager.js';
import type { TaskExecutorPort } from '../src/orchestration/tasks/task-executor.js';
import type { AgentStore, FinishTaskResult } from '../src/storage/agent-store.js';

describe('Session deletion coordination', () => {
  it('commits the durable fence before aborting local execution and publishes terminal state', async () => {
    const order: string[] = [];
    const finish = cancelledTaskFinish();
    const beginDeletion = vi.fn(async () => {
      order.push('fence');
      return { existed: true, taskFinishes: [finish] };
    });
    const abortSessionExecutions = vi.fn(async () => {
      order.push('abort');
    });
    const publish = vi.fn<(event: AgentRealtimeEvent) => Promise<void>>(async () => undefined);
    const manager = new TaskManager({
      store: { sessions: { beginDeletion } } as unknown as AgentStore,
      workerId: 'worker_1',
      ownershipTimeoutMs: 30_000,
      publisher: { publish },
      execution: {
        abortSessionExecutions,
      } as unknown as TaskExecutorPort,
      clock: { nowMs: () => 1_000 },
    });

    await expect(manager.prepareSessionDeletion('session_1')).resolves.toBe(true);

    expect(order).toEqual(['fence', 'abort']);
    expect(beginDeletion).toHaveBeenCalledWith({ sessionId: 'session_1', nowMs: 1_000 });
    expect(abortSessionExecutions).toHaveBeenCalledWith('session_1');
    expect(publish.mock.calls.map(([event]) => event.type)).toEqual([
      'task.upserted',
      'plan.cleared',
    ]);
  });
});

function cancelledTaskFinish(): FinishTaskResult {
  return {
    task: {
      id: 'task_1',
      sessionId: 'session_1',
      goalMessageId: 'message_goal_1',
      status: 'cancelled',
      version: 2,
      createdAtMs: 10,
      updatedAtMs: 1_000,
      startedAtMs: 20,
      completedAtMs: 1_000,
    },
    toolCalls: [],
    toolRuns: [],
    userInputRequests: [],
    planCleared: true,
  };
}
