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

  it('marks an expired Job as recovery-required without executing it', async () => {
    const candidate = jobFixture({ leaseExpiresAtMs: 999 });
    const pausedJob = jobFixture({
      status: 'recovery_required',
      version: 2,
      currentAttemptId: undefined,
      leaseOwner: undefined,
      leaseExpiresAtMs: undefined,
    });
    const startedJob = jobFixture({
      version: 3,
      attemptNo: 2,
      currentAttemptId: 'attempt_recovered',
      leaseOwner: 'worker_test',
      leaseExpiresAtMs: 31_000,
    });
    const store = recoveryStore(candidate, pausedJob, [], startedJob);
    const executor: JobExecutionService = {
      execute: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
    const runtime = createRuntime(store, executor);

    await runtime.start();
    await runtime.stop();

    expect(store.abandonStartedModelCalls).toHaveBeenCalledWith(1_000);
    expect(store.listJobsNeedingRuntimeRecovery).toHaveBeenCalledWith({
      nowMs: 1_000,
      createdBeforeMs: -59_000,
      limit: 32,
    });
    expect(store.markJobRecoveryRequired).toHaveBeenCalledWith({
      jobId: candidate.id,
      expectedVersion: candidate.version,
      nowMs: 1_000,
    });
    expect(store.startJobExecution).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(store.failJob).not.toHaveBeenCalled();
  });

  it('resumes a recovery-required Job only after an explicit request', async () => {
    const candidate = jobFixture({ leaseExpiresAtMs: 999 });
    const pausedJob = jobFixture({
      status: 'recovery_required', version: 2,
      currentAttemptId: undefined, leaseOwner: undefined, leaseExpiresAtMs: undefined,
    });
    const startedJob = jobFixture({
      version: 3,
      attemptNo: 2,
      currentAttemptId: 'attempt_recovered',
      leaseOwner: 'worker_test',
      leaseExpiresAtMs: 31_000,
    });
    const store = recoveryStore(candidate, pausedJob, [], startedJob);
    const executor: JobExecutionService = {
      execute: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
    const runtime = createRuntime(store, executor);

    await runtime.start();
    expect(executor.execute).not.toHaveBeenCalled();

    await expect(runtime.resumeJob(pausedJob.id, pausedJob.version)).resolves.toEqual(startedJob);
    expect(store.startJobExecution).toHaveBeenCalledWith(expect.objectContaining({
      jobId: pausedJob.id,
      expectedVersion: pausedJob.version,
      workerId: 'worker_test',
    }));
    expect(store.prepareToolInvocationsForRecovery).toHaveBeenCalledWith(expect.objectContaining({
      jobId: startedJob.id,
      attemptId: startedJob.currentAttemptId,
    }));
    expect(executor.execute).toHaveBeenCalledWith(candidate.id);
    await runtime.stop();
  });

  it('blocks an interrupted side-effecting tool when the user resumes', async () => {
    const candidate = jobFixture({ leaseExpiresAtMs: 999 });
    const pausedJob = jobFixture({
      status: 'recovery_required', version: 2,
      currentAttemptId: undefined, leaseOwner: undefined, leaseExpiresAtMs: undefined,
    });
    const startedJob = jobFixture({
      version: 3, attemptNo: 2, currentAttemptId: 'attempt_recovered',
      leaseOwner: 'worker_test', leaseExpiresAtMs: 31_000,
    });
    const invocation = invocationFixture();
    const store = recoveryStore(candidate, pausedJob, [invocation], startedJob);
    const executor: JobExecutionService = {
      execute: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
    const runtime = createRuntime(store, executor);

    await runtime.start();
    await runtime.resumeJob(pausedJob.id, pausedJob.version);
    await runtime.stop();

    expect(store.failJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: candidate.id,
      workerId: 'worker_test',
      attemptId: startedJob.currentAttemptId,
      error: expect.objectContaining({ code: 'unsafe_tool_recovery' }),
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
  pausedJob: AgentJob,
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
    markJobRecoveryRequired: vi.fn(async () => pausedJob),
    getJob: vi.fn(async () => pausedJob),
    listSessionToolInvocations: vi.fn(async () => invocations),
    startJobExecution: vi.fn(async () => startedJob),
    prepareToolInvocationsForRecovery: vi.fn(async () => ({
      invocations: invocations.filter(invocation => invocation.sideEffectLevel !== 'side_effecting'),
      blockedInvocations: invocations.filter(invocation => (
        invocation.status === 'running' && invocation.sideEffectLevel === 'side_effecting'
      )),
    })),
    failJob: vi.fn(async () => failed),
  } as unknown as AgentStore & {
    abandonStartedModelCalls: ReturnType<typeof vi.fn>;
    listJobsNeedingRuntimeRecovery: ReturnType<typeof vi.fn>;
    markJobRecoveryRequired: ReturnType<typeof vi.fn>;
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
    executionAttemptNo: 1,
    version: 1,
    createdAtMs: 200,
    startedAtMs: 210,
    updatedAtMs: 210,
  };
}
