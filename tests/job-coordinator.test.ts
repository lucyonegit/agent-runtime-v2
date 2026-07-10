import { describe, expect, it, vi } from 'vitest';
import type { AgentJob, AgentMessage, AgentSession } from '../src/domain/index.js';
import { JobCoordinator } from '../src/runtime/job-coordinator.js';
import { resolveExecutionLimits } from '../src/runtime/execution-limits.js';
import {
  AgentStoreError,
  type AgentStore,
} from '../src/storage/agent-store.js';

describe('JobCoordinator', () => {
  it('generates an attempt and a bounded lease for each claim', async () => {
    const store = createStore();
    const claimed = { ...jobFixture, status: 'running', version: 1 } as AgentJob;
    vi.mocked(store.claimJob).mockResolvedValue(claimed);
    const coordinator = createCoordinator(store, 1_000);

    await expect(coordinator.claimJob('job_1', 0)).resolves.toBe(claimed);
    expect(store.claimJob).toHaveBeenCalledWith({
      jobId: 'job_1',
      expectedVersion: 0,
      workerId: 'worker_1',
      attemptId: 'attempt_1',
      nowMs: 1_000,
      leaseUntilMs: 31_000,
    });
  });

  it('returns the committed entities for an identical client request replay', async () => {
    const store = createStore();
    vi.mocked(store.createJobAndAppendUserMessage).mockRejectedValue(new AgentStoreError(
      'CLIENT_REQUEST_CONFLICT',
      'duplicate request'
    ));
    vi.mocked(store.getSession).mockResolvedValue(sessionFixture);
    vi.mocked(store.getJobByClientRequestId).mockResolvedValue({
      ...jobFixture,
      clientRequestId: 'request_1',
    });
    vi.mocked(store.listSessionMessages).mockResolvedValue([messageFixture]);
    const coordinator = createCoordinator(store, 1_000);

    await expect(coordinator.createJob({
      sessionId: 'session_1',
      content: 'hello',
      clientRequestId: 'request_1',
    })).resolves.toEqual({
      session: sessionFixture,
      job: { ...jobFixture, clientRequestId: 'request_1' },
      message: messageFixture,
    });
  });

  it('rejects client request reuse with a different payload', async () => {
    const store = createStore();
    vi.mocked(store.createJobAndAppendUserMessage).mockRejectedValue(new AgentStoreError(
      'CLIENT_REQUEST_CONFLICT',
      'duplicate request'
    ));
    vi.mocked(store.getSession).mockResolvedValue(sessionFixture);
    vi.mocked(store.getJobByClientRequestId).mockResolvedValue(jobFixture);
    vi.mocked(store.listSessionMessages).mockResolvedValue([messageFixture]);
    const coordinator = createCoordinator(store, 1_000);

    await expect(coordinator.createJob({
      sessionId: 'session_1',
      content: 'different',
      clientRequestId: 'request_1',
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('creates retry as a new Job linked to the failed source', async () => {
    const store = createStore();
    const failedJob = {
      ...jobFixture,
      status: 'failed',
      version: 2,
      completedAtMs: 900,
    } as AgentJob;
    vi.mocked(store.getJob).mockResolvedValue(failedJob);
    vi.mocked(store.listSessionMessages).mockResolvedValue([messageFixture]);
    vi.mocked(store.createJobAndAppendUserMessage).mockImplementation(async input => ({
      session: sessionFixture,
      job: { ...jobFixture, id: input.jobId, retryOfJobId: input.retryOfJobId },
      message: { ...messageFixture, id: input.userMessageId, jobId: input.jobId },
    }));
    const coordinator = createCoordinator(store, 1_000);

    const retry = await coordinator.retryJob({ failedJobId: 'job_1' });
    expect(retry.job).toMatchObject({ id: 'job_2', retryOfJobId: 'job_1' });
    expect(store.createJobAndAppendUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: 'hello',
      retryOfJobId: 'job_1',
      jobId: 'job_2',
      userMessageId: 'message_2',
    }));
  });

  it('maps stale versions and lease loss into stable runtime errors', async () => {
    const store = createStore();
    vi.mocked(store.claimJob).mockRejectedValue(new AgentStoreError(
      'CONCURRENCY_CONFLICT',
      'stale'
    ));
    const coordinator = createCoordinator(store, 1_000);

    await expect(coordinator.claimJob('job_1', 0)).rejects.toMatchObject({
      code: 'concurrency_conflict',
      retryable: false,
    });
    await expect(coordinator.renewJobLease(jobFixture)).rejects.toMatchObject({
      code: 'lease_lost',
      retryable: false,
    });
  });
});

describe('execution limits', () => {
  it('requires heartbeat to be shorter than the Job lease', () => {
    expect(() => resolveExecutionLimits({ jobLeaseMs: 10_000, jobHeartbeatMs: 10_000 }))
      .toThrow(/shorter/);
    expect(resolveExecutionLimits({ jobLeaseMs: 20_000, jobHeartbeatMs: 5_000 }))
      .toMatchObject({ jobLeaseMs: 20_000, jobHeartbeatMs: 5_000 });
  });
});

function createCoordinator(store: AgentStore, nowMs: number): JobCoordinator {
  let jobNo = 1;
  let messageNo = 1;
  let attemptNo = 1;
  return new JobCoordinator({
    store,
    workerId: 'worker_1',
    clock: { nowMs: () => nowMs },
    ids: {
      jobId: () => `job_${++jobNo}`,
      messageId: () => `message_${++messageNo}`,
      attemptId: () => `attempt_${attemptNo++}`,
    },
  });
}

function createStore(): AgentStore {
  return {
    createSession: vi.fn<AgentStore['createSession']>(),
    getSession: vi.fn<AgentStore['getSession']>(),
    getJob: vi.fn<AgentStore['getJob']>(),
    getJobByClientRequestId: vi.fn<AgentStore['getJobByClientRequestId']>(),
    getToolInvocation: vi.fn<AgentStore['getToolInvocation']>(),
    getPlanByJobId: vi.fn<AgentStore['getPlanByJobId']>(),
    listPlanSteps: vi.fn<AgentStore['listPlanSteps']>(),
    listJobStepRuns: vi.fn<AgentStore['listJobStepRuns']>(),
    listModelCalls: vi.fn<AgentStore['listModelCalls']>(),
    getModelUsageStats: vi.fn<AgentStore['getModelUsageStats']>(),
    listActiveContextSummaries: vi.fn<AgentStore['listActiveContextSummaries']>(),
    listSessionMessages: vi.fn<AgentStore['listSessionMessages']>(),
    createJobAndAppendUserMessage: vi.fn<AgentStore['createJobAndAppendUserMessage']>(),
    claimJob: vi.fn<AgentStore['claimJob']>(),
    renewJobLease: vi.fn<AgentStore['renewJobLease']>(),
    commitModelToolCalls: vi.fn<AgentStore['commitModelToolCalls']>(),
    claimToolInvocation: vi.fn<AgentStore['claimToolInvocation']>(),
    commitToolResult: vi.fn<AgentStore['commitToolResult']>(),
    completeJobWithFinalMessage: vi.fn<AgentStore['completeJobWithFinalMessage']>(),
    createInputRequestsAndMarkWaiting: vi.fn<AgentStore['createInputRequestsAndMarkWaiting']>(),
    answerInputAndClaimResume: vi.fn<AgentStore['answerInputAndClaimResume']>(),
    routeJob: vi.fn<AgentStore['routeJob']>(),
    createPlan: vi.fn<AgentStore['createPlan']>(),
    createStepRun: vi.fn<AgentStore['createStepRun']>(),
    commitStepOutput: vi.fn<AgentStore['commitStepOutput']>(),
    failStepRun: vi.fn<AgentStore['failStepRun']>(),
    startModelCall: vi.fn<AgentStore['startModelCall']>(),
    completeModelCall: vi.fn<AgentStore['completeModelCall']>(),
    abandonStartedModelCalls: vi.fn<AgentStore['abandonStartedModelCalls']>(),
    replaceContextSummary: vi.fn<AgentStore['replaceContextSummary']>(),
    failJob: vi.fn<AgentStore['failJob']>(),
    cancelJob: vi.fn<AgentStore['cancelJob']>(),
  };
}

const sessionFixture: AgentSession = {
  id: 'session_1',
  mode: 'agent',
  status: 'active',
  version: 1,
  createdAtMs: 1,
  updatedAtMs: 2,
};

const jobFixture: AgentJob = {
  id: 'job_1',
  sessionId: 'session_1',
  stage: 'routing',
  status: 'created',
  attemptNo: 0,
  version: 0,
  createdAtMs: 2,
  updatedAtMs: 2,
};

const messageFixture: AgentMessage = {
  rowId: 1,
  id: 'message_1',
  sessionId: 'session_1',
  jobId: 'job_1',
  role: 'user',
  messageType: 'user_message',
  visibility: 'ui',
  channel: 'normal',
  content: 'hello',
  createdAtMs: 2,
};
