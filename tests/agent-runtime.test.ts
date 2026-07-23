import { describe, expect, it, vi } from 'vitest';
import type { AgentJob, AgentToolInvocation } from '../src/domain/index.js';
import { AgentRuntime } from '../src/orchestration/agent-runtime.js';
import type { JobExecutionController } from '../src/orchestration/job-execution-manager.js';
import { JobLifecycle } from '../src/orchestration/job-lifecycle.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('AgentRuntime commands', () => {
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
    const jobExecution = executionController({
      cancelJobExecution: vi.fn(() => { order.push('aborted'); }),
    });
    const runtime = createRuntime(store, jobExecution);

    await expect(runtime.cancelJob(running.id, running.version)).resolves.toEqual(cancelled);
    expect(order).toEqual(['persisted', 'aborted']);
    expect(jobExecution.cancelJobExecution).toHaveBeenCalledWith(running.id);
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
    const jobExecution = executionController();
    const runtime = createRuntime(store, jobExecution);

    expect(jobExecution.executeJob).not.toHaveBeenCalled();

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
    expect(jobExecution.executeJob).toHaveBeenCalledWith(candidate.id);
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
    const jobExecution = executionController();
    const runtime = createRuntime(store, jobExecution);

    await runtime.resumeJob(pausedJob.id, pausedJob.version);

    expect(store.failJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: candidate.id,
      workerId: 'worker_test',
      attemptId: startedJob.currentAttemptId,
      error: expect.objectContaining({ code: 'unsafe_tool_recovery' }),
    }));
    expect(jobExecution.executeJob).not.toHaveBeenCalled();
  });

  it('delegates process startup and shutdown to the execution manager', async () => {
    const jobExecution = executionController();
    const runtime = createRuntime({} as AgentStore, jobExecution);

    await runtime.start();
    await runtime.stop();

    expect(jobExecution.start).toHaveBeenCalledOnce();
    expect(jobExecution.shutdown).toHaveBeenCalledOnce();
  });
});

function createRuntime(
  store: AgentStore,
  jobExecution: JobExecutionController
): AgentRuntime {
  const jobLifecycle = new JobLifecycle({
    store,
    workerId: 'worker_test',
    clock: { nowMs: () => 1_000 },
    limits: {
      jobLeaseMs: 30_000,
      jobHeartbeatMs: 10_000,
    },
    ids: {
      jobId: () => 'job_generated',
      messageId: () => 'message_generated',
      attemptId: () => 'attempt_recovered',
    },
  });
  return new AgentRuntime({
    store,
    jobLifecycle,
    jobExecution,
    publisher: { publish: vi.fn(async () => undefined) },
    clock: { nowMs: () => 1_000 },
    ids: {
      sessionId: () => 'session_generated',
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

function executionController(
  overrides: Partial<JobExecutionController> = {}
): JobExecutionController {
  return {
    start: vi.fn(async () => undefined),
    executeJob: vi.fn(async () => undefined),
    cancelJobExecution: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
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
