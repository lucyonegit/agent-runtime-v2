import { describe, expect, it, vi } from 'vitest';
import type { AgentJob } from '../src/domain/index.js';
import { JobExecutor } from '../src/orchestration/jobs/job-executor.js';
import { JobStore } from '../src/orchestration/jobs/shared/job-store.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('JobExecutor recovery', () => {
  it('marks interrupted Jobs for explicit recovery without restarting them', async () => {
    const candidate = jobFixture({ leaseExpiresAtMs: 999 });
    const recoveryRequiredJob = jobFixture({
      status: 'recovery_required',
      version: 2,
      currentAttemptId: undefined,
      leaseOwner: undefined,
      leaseExpiresAtMs: undefined,
    });
    const store = {
      abandonStartedModelCalls: vi.fn(async () => []),
      listJobsNeedingRuntimeRecovery: vi.fn(async () => [candidate]),
      markJobRecoveryRequired: vi.fn(async () => recoveryRequiredJob),
      startJobExecution: vi.fn(),
    } as unknown as AgentStore;
    const publisher = { publish: vi.fn(async () => undefined) };
    const clock = { nowMs: () => 1_000 };
    const jobStore = new JobStore({
      store,
      workerId: 'worker_test',
      jobLeaseMs: 30_000,
      clock,
    });
    const executor = new JobExecutor({
      store,
      jobStore,
      reactExecution: { runJob: vi.fn(async () => undefined as never) },
      workerId: 'worker_test',
      publisher,
      recoveryIntervalMs: 60_000,
      recoveryBatchSize: 32,
      clock,
    });

    await executor.start();
    await executor.shutdown();

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
    expect(publisher.publish).toHaveBeenCalledWith({
      type: 'job.upserted',
      sessionId: recoveryRequiredJob.sessionId,
      job: recoveryRequiredJob,
    });
    expect(store.startJobExecution).not.toHaveBeenCalled();
  });
});

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
