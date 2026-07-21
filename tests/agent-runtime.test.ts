import { describe, expect, it, vi } from 'vitest';
import type { AgentJob, AgentToolInvocation } from '../src/domain/index.js';
import { AgentRuntime, type JobExecutionService } from '../src/orchestration/agent-runtime.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('AgentRuntime cancellation and recovery', () => {
  it('persists cancellation before aborting the live executor', async () => {
    const order: string[] = [];
    const running = jobFixture();
    const cancelled = { ...running, status: 'cancelled' as const, version: 2, completedAtMs: 1_000 };
    const store = {
      cancelJob: vi.fn(async () => {
        order.push('persisted');
        return cancelled;
      }),
    } as unknown as AgentStore;
    const executor: JobExecutionService = {
      execute: vi.fn(async () => undefined),
      cancel: vi.fn(() => { order.push('aborted'); }),
    };
    const runtime = createRuntime(store, executor);

    await expect(runtime.cancelJob(running.id, running.version)).resolves.toEqual(cancelled);
    expect(order).toEqual(['persisted', 'aborted']);
    expect(executor.cancel).toHaveBeenCalledWith(running.id);
  });

  it('reclaims an expired Job at a safe ReAct boundary', async () => {
    const candidate = jobFixture({ leaseExpiresAtMs: 999 });
    const startedJob = jobFixture({
      version: 2,
      attemptNo: 2,
      currentAttemptId: 'attempt_recovered',
      leaseOwner: 'worker_test',
      leaseExpiresAtMs: 31_000,
    });
    const store = recoveryStore(candidate, [], startedJob);
    const executor: JobExecutionService = {
      execute: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
    const runtime = createRuntime(store, executor);

    await runtime.start();
    await runtime.stop();

    expect(store.abandonStartedModelCalls).toHaveBeenCalledWith(1_000);
    expect(store.listJobsNeedingRuntimeRecovery).toHaveBeenCalledWith({ nowMs: 1_000, limit: 32 });
    expect(store.startJobExecution).toHaveBeenCalledWith(expect.objectContaining({
      jobId: candidate.id,
      expectedVersion: candidate.version,
      workerId: 'worker_test',
    }));
    expect(executor.execute).toHaveBeenCalledWith(candidate.id);
    expect(store.failJob).not.toHaveBeenCalled();
  });

  it('fails an interrupted tool boundary instead of replaying a possible side effect', async () => {
    const candidate = jobFixture({ leaseExpiresAtMs: 999 });
    const startedJob = jobFixture({
      version: 2,
      attemptNo: 2,
      currentAttemptId: 'attempt_recovered',
      leaseOwner: 'worker_test',
      leaseExpiresAtMs: 31_000,
    });
    const invocation = invocationFixture();
    const store = recoveryStore(candidate, [invocation], startedJob);
    const executor: JobExecutionService = {
      execute: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
    const runtime = createRuntime(store, executor);

    await runtime.start();
    await runtime.stop();

    expect(store.failJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: candidate.id,
      workerId: 'worker_test',
      attemptId: startedJob.currentAttemptId,
      error: expect.objectContaining({ code: 'execution_interrupted' }),
    }));
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

function createRuntime(store: AgentStore, executor: JobExecutionService): AgentRuntime {
  return new AgentRuntime({
    store,
    executor,
    workerId: 'worker_test',
    publisher: { publish: vi.fn(async () => undefined) },
    clock: { nowMs: () => 1_000 },
    recoveryIntervalMs: 60_000,
    ids: {
      sessionId: () => 'session_generated',
      jobId: () => 'job_generated',
      messageId: () => 'message_generated',
      attemptId: () => 'attempt_recovered',
    },
  });
}

function recoveryStore(
  candidate: AgentJob,
  invocations: AgentToolInvocation[],
  startedJob: AgentJob
) {
  const failed = {
    ...startedJob,
    status: 'failed' as const,
    version: startedJob.version + 1,
    completedAtMs: 1_000,
  };
  return {
    abandonStartedModelCalls: vi.fn(async () => []),
    listJobsNeedingRuntimeRecovery: vi.fn(async () => [candidate]),
    listSessionToolInvocations: vi.fn(async () => invocations),
    startJobExecution: vi.fn(async () => startedJob),
    failJob: vi.fn(async () => failed),
  } as unknown as AgentStore & {
    abandonStartedModelCalls: ReturnType<typeof vi.fn>;
    listJobsNeedingRuntimeRecovery: ReturnType<typeof vi.fn>;
    startJobExecution: ReturnType<typeof vi.fn>;
    failJob: ReturnType<typeof vi.fn>;
  };
}

function jobFixture(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job_1',
    sessionId: 'session_1',
    status: 'running',
    currentAttemptId: 'attempt_1',
    attemptNo: 1,
    leaseOwner: 'worker_dead',
    leaseExpiresAtMs: 900,
    version: 1,
    createdAtMs: 100,
    updatedAtMs: 200,
    startedAtMs: 150,
    ...overrides,
  };
}

function invocationFixture(): AgentToolInvocation {
  return {
    id: 'invocation_1',
    sessionId: 'session_1',
    jobId: 'job_1',
    attemptId: 'attempt_1',
    callMessageId: 'message_call',
    toolCallId: 'call_1',
    toolName: 'run_shell',
    arguments: { command: 'npm install' },
    argumentsChecksum: 'checksum',
    sideEffectLevel: 'side_effecting',
    idempotencyKey: 'job_1:call_1',
    status: 'running',
    version: 1,
    createdAtMs: 200,
    startedAtMs: 210,
    updatedAtMs: 210,
  };
}
