import { describe, expect, it, vi } from 'vitest';
import type { AgentJob, AgentMessage, AgentSession } from '../src/domain/index.js';
import { JobCoordinator } from '../src/orchestration/lifecycle/job-coordinator.js';
import { resolveExecutionLimits } from '../src/runtime/execution/execution-limits.js';
import {
  AgentStoreError,
  type AgentStore,
} from '../src/storage/agent-store.js';

describe('JobCoordinator', () => {
  it('generates an attempt and a bounded lease when execution starts', async () => {
    const store = createStore();
    const startedJob = { ...jobFixture, status: 'running', version: 1 } as AgentJob;
    vi.mocked(store.startJobExecution).mockResolvedValue(startedJob);
    const coordinator = createCoordinator(store, 1_000);

    await expect(coordinator.startJobExecution('job_1', 0)).resolves.toBe(startedJob);
    expect(store.startJobExecution).toHaveBeenCalledWith({
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

  it('creates retry as a new Job that reuses the original goal message', async () => {
    const store = createStore();
    const failedJob = {
      ...jobFixture,
      status: 'failed',
      version: 2,
      completedAtMs: 900,
    } as AgentJob;
    vi.mocked(store.getJob).mockResolvedValue(failedJob);
    vi.mocked(store.listSessionMessages).mockResolvedValue([messageFixture]);
    vi.mocked(store.createRetryJob).mockImplementation(async input => ({
      session: sessionFixture,
      job: { ...jobFixture, id: input.jobId, retryOfJobId: input.retryOfJobId },
    }));
    const coordinator = createCoordinator(store, 1_000);

    const retry = await coordinator.retryJob({ failedJobId: 'job_1' });
    expect(retry.job).toMatchObject({ id: 'job_2', retryOfJobId: 'job_1' });
    expect(retry).not.toHaveProperty('message');
    expect(store.createRetryJob).toHaveBeenCalledWith(expect.objectContaining({
      retryOfJobId: 'job_1',
      jobId: 'job_2',
      jobMetadata: expect.objectContaining({ goalMessageId: 'message_1' }),
    }));
    expect(store.createJobAndAppendUserMessage).not.toHaveBeenCalled();
  });

  it('creates a new goal message when retry content is explicitly replaced', async () => {
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

    await coordinator.retryJob({ failedJobId: 'job_1', content: 'new goal' });

    expect(store.createJobAndAppendUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: 'new goal',
      retryOfJobId: 'job_1',
      jobId: 'job_2',
      userMessageId: 'message_2',
      jobMetadata: expect.objectContaining({ goalMessageId: 'message_2' }),
    }));
    expect(store.createRetryJob).not.toHaveBeenCalled();
  });

  it('maps stale versions and lease loss into stable runtime errors', async () => {
    const store = createStore();
    vi.mocked(store.startJobExecution).mockRejectedValue(new AgentStoreError(
      'CONCURRENCY_CONFLICT',
      'stale'
    ));
    const coordinator = createCoordinator(store, 1_000);

    await expect(coordinator.startJobExecution('job_1', 0)).rejects.toMatchObject({
      code: 'concurrency_conflict',
      retryable: false,
    });
    await expect(coordinator.renewJobExecutionLease(jobFixture)).rejects.toMatchObject({
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
    listSessions: vi.fn<AgentStore['listSessions']>(),
    deleteSession: vi.fn<AgentStore['deleteSession']>(),
    getSession: vi.fn<AgentStore['getSession']>(),
    getJob: vi.fn<AgentStore['getJob']>(),
    getJobByClientRequestId: vi.fn<AgentStore['getJobByClientRequestId']>(),
    getToolInvocation: vi.fn<AgentStore['getToolInvocation']>(),
    getLatestLoopCheckpoint: vi.fn<AgentStore['getLatestLoopCheckpoint']>(),
    getPlanByJobId: vi.fn<AgentStore['getPlanByJobId']>(),
    listPlanSteps: vi.fn<AgentStore['listPlanSteps']>(),
    getModelCall: vi.fn<AgentStore['getModelCall']>(),
    listModelCalls: vi.fn<AgentStore['listModelCalls']>(),
    listRecentSessionModelCalls: vi.fn<AgentStore['listRecentSessionModelCalls']>(),
    getModelUsageStats: vi.fn<AgentStore['getModelUsageStats']>(),
    listActiveContextSummaries: vi.fn<AgentStore['listActiveContextSummaries']>(),
    getContextSummariesByIds: vi.fn<AgentStore['getContextSummariesByIds']>(),
    listSessionMessages: vi.fn<AgentStore['listSessionMessages']>(),
    listSessionJobs: vi.fn<AgentStore['listSessionJobs']>(),
    listSessionPlans: vi.fn<AgentStore['listSessionPlans']>(),
    listSessionPlanSteps: vi.fn<AgentStore['listSessionPlanSteps']>(),
    listSessionToolInvocations: vi.fn<AgentStore['listSessionToolInvocations']>(),
    listSessionArtifacts: vi.fn<AgentStore['listSessionArtifacts']>(),
    listSessionUserInputRequests: vi.fn<AgentStore['listSessionUserInputRequests']>(),
    listJobsNeedingRuntimeRecovery: vi.fn<AgentStore['listJobsNeedingRuntimeRecovery']>(),
    markJobRecoveryRequired: vi.fn<AgentStore['markJobRecoveryRequired']>(),
    createJobAndAppendUserMessage: vi.fn<AgentStore['createJobAndAppendUserMessage']>(),
    createRetryJob: vi.fn<AgentStore['createRetryJob']>(),
    startJobExecution: vi.fn<AgentStore['startJobExecution']>(),
    renewJobExecutionLease: vi.fn<AgentStore['renewJobExecutionLease']>(),
    commitModelToolCalls: vi.fn<AgentStore['commitModelToolCalls']>(),
    tryStartToolExecution: vi.fn<AgentStore['tryStartToolExecution']>(),
    prepareToolInvocationsForRecovery: vi.fn<AgentStore['prepareToolInvocationsForRecovery']>(),
    commitToolResult: vi.fn<AgentStore['commitToolResult']>(),
    completeJobWithFinalMessage: vi.fn<AgentStore['completeJobWithFinalMessage']>(),
    createInputRequestsAndMarkWaiting: vi.fn<AgentStore['createInputRequestsAndMarkWaiting']>(),
    saveUserInputAnswerAndResumeIfReady: vi.fn<AgentStore['saveUserInputAnswerAndResumeIfReady']>(),
    applyPlanUpdate: vi.fn<AgentStore['applyPlanUpdate']>(),
    startModelCall: vi.fn<AgentStore['startModelCall']>(),
    completeModelCall: vi.fn<AgentStore['completeModelCall']>(),
    setModelCallOutputDisposition: vi.fn<AgentStore['setModelCallOutputDisposition']>(),
    abandonStartedModelCalls: vi.fn<AgentStore['abandonStartedModelCalls']>(),
    replaceContextSummary: vi.fn<AgentStore['replaceContextSummary']>(),
    failJob: vi.fn<AgentStore['failJob']>(),
    cancelJob: vi.fn<AgentStore['cancelJob']>(),
  };
}

const sessionFixture: AgentSession = {
  id: 'session_1',
  status: 'active',
  version: 1,
  createdAtMs: 1,
  updatedAtMs: 2,
};

const jobFixture: AgentJob = {
  id: 'job_1',
  sessionId: 'session_1',
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
