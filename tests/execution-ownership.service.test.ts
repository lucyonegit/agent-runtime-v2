import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionOwnershipService } from '../src/orchestration/tasks/shared/execution-ownership.service.js';
import { AgentStoreError, type AgentStore } from '../src/storage/agent-store.js';

describe('ExecutionOwnershipService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fences the execution immediately when the store confirms ownership loss', async () => {
    const renewRunOwnership = vi.fn(async () => {
      throw new AgentStoreError('TASK_OWNERSHIP_LOST', 'The lease belongs to another run.');
    });
    const onOwnershipLost = vi.fn();
    const stop = service(renewRunOwnership).startRefreshing({
      taskId: 'task_1',
      taskRunId: 'task_run_1',
      ownershipExpiresAtMs: 30_000,
      onOwnershipLost,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(onOwnershipLost).toHaveBeenCalledOnce();
    expect(onOwnershipLost.mock.calls[0]![0]).toMatchObject({ code: 'ownership_lost' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewRunOwnership).toHaveBeenCalledOnce();
    stop();
  });

  it('retries transient failures only while the last confirmed lease is valid', async () => {
    const renewRunOwnership = vi.fn(async () => {
      throw new Error('Database temporarily unavailable.');
    });
    const onOwnershipLost = vi.fn();
    const stop = service(renewRunOwnership).startRefreshing({
      taskId: 'task_1',
      taskRunId: 'task_run_1',
      ownershipExpiresAtMs: 25_000,
      onOwnershipLost,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(renewRunOwnership).toHaveBeenCalledTimes(2);
    expect(onOwnershipLost).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onOwnershipLost).toHaveBeenCalledOnce();
    expect(onOwnershipLost.mock.calls[0]![0]).toMatchObject({ code: 'ownership_lost' });
    stop();
  });

  it('fences a renewal request that is still pending when the lease expires', async () => {
    const renewRunOwnership = vi.fn(() => new Promise<never>(() => undefined));
    const onOwnershipLost = vi.fn();
    const stop = service(renewRunOwnership).startRefreshing({
      taskId: 'task_1',
      taskRunId: 'task_run_1',
      ownershipExpiresAtMs: 25_000,
      onOwnershipLost,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(renewRunOwnership).toHaveBeenCalledOnce();
    expect(onOwnershipLost).toHaveBeenCalledOnce();
    expect(onOwnershipLost.mock.calls[0]![0]).toMatchObject({ code: 'ownership_lost' });
    stop();
  });
});

function service(renewRunOwnership: ReturnType<typeof vi.fn>) {
  return new ExecutionOwnershipService({
    store: {
      tasks: { renewRunOwnership },
    } as unknown as AgentStore,
    ownerId: 'worker_1',
    refreshIntervalMs: 10_000,
    ownershipTimeoutMs: 30_000,
    clock: { nowMs: () => Date.now() },
  });
}
