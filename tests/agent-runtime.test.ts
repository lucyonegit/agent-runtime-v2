import { describe, expect, it, vi } from 'vitest';
import type { AgentJob } from '../src/domain/index.js';
import { AgentRuntime } from '../src/orchestration/agent-runtime.js';
import type { JobManagerPort } from '../src/orchestration/job-manager.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('AgentRuntime application facade', () => {
  it('delegates process startup and shutdown to JobManager', async () => {
    const jobs = jobManager();
    const runtime = createRuntime({} as AgentStore, jobs);

    await runtime.start();
    await runtime.stop();

    expect(jobs.start).toHaveBeenCalledOnce();
    expect(jobs.shutdown).toHaveBeenCalledOnce();
  });

  it('delegates Job commands without knowing execution or persistence details', async () => {
    const jobs = jobManager();
    const cancelled = jobFixture({ status: 'cancelled', version: 2, completedAtMs: 1_000 });
    vi.mocked(jobs.cancelJob).mockResolvedValue(cancelled);
    const runtime = createRuntime({} as AgentStore, jobs);

    await expect(runtime.cancelJob('job_1', 1)).resolves.toBe(cancelled);

    expect(jobs.cancelJob).toHaveBeenCalledWith('job_1', 1);
  });
});

function createRuntime(store: AgentStore, jobs: JobManagerPort): AgentRuntime {
  return new AgentRuntime({
    store,
    jobs,
    clock: { nowMs: () => 1_000 },
    ids: { sessionId: () => 'session_generated' },
  });
}

function jobManager(): JobManagerPort {
  return {
    start: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    createJob: vi.fn<JobManagerPort['createJob']>(),
    cancelJob: vi.fn<JobManagerPort['cancelJob']>(),
    retryJob: vi.fn<JobManagerPort['retryJob']>(),
    resumeJob: vi.fn<JobManagerPort['resumeJob']>(),
    answerUserInputRequest: vi.fn<JobManagerPort['answerUserInputRequest']>(),
  };
}

function jobFixture(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job_1',
    sessionId: 'session_1',
    status: 'running',
    currentAttemptId: 'attempt_1',
    attemptNo: 1,
    leaseOwner: 'worker_test',
    leaseExpiresAtMs: 31_000,
    version: 1,
    createdAtMs: 100,
    updatedAtMs: 200,
    startedAtMs: 150,
    ...overrides,
  };
}
