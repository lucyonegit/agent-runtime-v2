import { describe, expect, it, vi } from 'vitest';
import type { AgentJob } from '../src/domain/index.js';
import { JobExecutor } from '../src/orchestration/jobs/job-executor.js';
import { JobActions } from '../src/orchestration/jobs/shared/job-actions.js';
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
      models: {
        abandonStartedCalls: vi.fn(async () => []),
      },
      jobs: {
        listNeedingRecovery: vi.fn(async () => [candidate]),
        markRecoveryRequired: vi.fn(async () => recoveryRequiredJob),
        startExecution: vi.fn(),
      },
    } as unknown as AgentStore;
    const publisher = { publish: vi.fn(async () => undefined) };
    const clock = { nowMs: () => 1_000 };
    const jobActions = new JobActions({
      store,
      workerId: 'worker_test',
      jobLeaseMs: 30_000,
      clock,
    });
    const executor = new JobExecutor({
      store,
      jobActions,
      reactExecution: { runJob: vi.fn(async () => undefined as never) },
      workerId: 'worker_test',
      publisher,
      recoveryIntervalMs: 60_000,
      recoveryBatchSize: 32,
      clock,
    });

    await executor.start();
    await executor.shutdown();

    expect(store.models.abandonStartedCalls).toHaveBeenCalledWith(1_000);
    expect(store.jobs.listNeedingRecovery).toHaveBeenCalledWith({
      nowMs: 1_000,
      createdBeforeMs: -59_000,
      limit: 32,
    });
    expect(store.jobs.markRecoveryRequired).toHaveBeenCalledWith({
      jobId: candidate.id,
      expectedVersion: candidate.version,
      nowMs: 1_000,
    });
    expect(publisher.publish).toHaveBeenCalledWith({
      type: 'job.upserted',
      sessionId: recoveryRequiredJob.sessionId,
      job: recoveryRequiredJob,
    });
    expect(store.jobs.startExecution).not.toHaveBeenCalled();
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
