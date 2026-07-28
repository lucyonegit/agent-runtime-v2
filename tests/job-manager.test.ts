import { describe, expect, it, vi } from 'vitest';
import type {
  AgentJob,
  AgentMessage,
  AgentSession,
  AgentToolInvocation,
  AgentUserInputRequest,
} from '../src/domain/index.js';
import type { JobExecutorPort } from '../src/orchestration/jobs/job-executor.js';
import { JobManager } from '../src/orchestration/jobs/job-manager.js';
import { JobStore } from '../src/orchestration/jobs/shared/job-store.js';
import { resolveExecutionLimits } from '../src/runtime/settings/execution-limits.js';
import {
  AgentStoreError,
  type AgentStore,
} from '../src/storage/agent-store.js';

describe('JobManager', () => {
  it('persists a new Job, starts an attempt, then schedules execution', async () => {
    const store = createStore();
    const createdJob = jobFixture({ id: 'job_2' });
    const message = messageFixtureFor(createdJob);
    const runningJob = jobFixture({
      id: 'job_2',
      status: 'running',
      version: 1,
      attemptNo: 1,
      currentAttemptId: 'attempt_1',
      leaseOwner: 'worker_1',
      leaseExpiresAtMs: 31_000,
      startedAtMs: 1_000,
    });
    vi.mocked(store.createJobAndAppendUserMessage).mockResolvedValue({
      session: sessionFixture,
      job: createdJob,
      message,
    });
    vi.mocked(store.startJobExecution).mockResolvedValue(runningJob);
    const { manager, execution } = createManager(store, 1_000);

    await expect(manager.createJob({
      sessionId: 'session_1',
      message: 'hello',
      clientRequestId: 'request_1',
    })).resolves.toMatchObject({ job: runningJob, message });

    expect(store.startJobExecution).toHaveBeenCalledWith({
      jobId: 'job_2',
      expectedVersion: 0,
      workerId: 'worker_1',
      attemptId: 'attempt_1',
      nowMs: 1_000,
      leaseUntilMs: 31_000,
    });
    expect(execution.startExecution).toHaveBeenCalledWith('job_2');
  });

  it('returns committed entities for an identical client request replay', async () => {
    const store = createStore();
    const completedJob = jobFixture({
      id: 'job_2',
      status: 'completed',
      version: 2,
      completedAtMs: 900,
      clientRequestId: 'request_1',
    });
    const committedMessage = messageFixtureFor(completedJob);
    vi.mocked(store.createJobAndAppendUserMessage).mockRejectedValue(new AgentStoreError(
      'CLIENT_REQUEST_CONFLICT',
      'duplicate request'
    ));
    vi.mocked(store.getSession).mockResolvedValue(sessionFixture);
    vi.mocked(store.getJobByClientRequestId).mockResolvedValue(completedJob);
    vi.mocked(store.listSessionMessages).mockResolvedValue([committedMessage]);
    const { manager, execution } = createManager(store, 1_000);

    await expect(manager.createJob({
      sessionId: 'session_1',
      message: 'hello',
      clientRequestId: 'request_1',
    })).resolves.toEqual({
      session: sessionFixture,
      job: completedJob,
      message: committedMessage,
    });
    expect(store.startJobExecution).not.toHaveBeenCalled();
    expect(execution.startExecution).not.toHaveBeenCalled();
  });

  it('rejects client request reuse with a different payload', async () => {
    const store = createStore();
    vi.mocked(store.createJobAndAppendUserMessage).mockRejectedValue(new AgentStoreError(
      'CLIENT_REQUEST_CONFLICT',
      'duplicate request'
    ));
    vi.mocked(store.getSession).mockResolvedValue(sessionFixture);
    vi.mocked(store.getJobByClientRequestId).mockResolvedValue(jobFixture({ id: 'job_2' }));
    vi.mocked(store.listSessionMessages).mockResolvedValue([
      messageFixtureFor(jobFixture({ id: 'job_2' })),
    ]);
    const { manager } = createManager(store, 1_000);

    await expect(manager.createJob({
      sessionId: 'session_1',
      message: 'different',
      clientRequestId: 'request_1',
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('creates Retry as a new Job that reuses the original goal message', async () => {
    const store = createStore();
    const failedJob = jobFixture({
      status: 'failed',
      version: 2,
      completedAtMs: 900,
    });
    const retryJob = jobFixture({ id: 'job_2', retryOfJobId: 'job_1' });
    const runningRetry = jobFixture({
      ...retryJob,
      status: 'running',
      version: 1,
      attemptNo: 1,
      currentAttemptId: 'attempt_1',
      leaseOwner: 'worker_1',
      leaseExpiresAtMs: 31_000,
    });
    vi.mocked(store.getJob).mockResolvedValue(failedJob);
    vi.mocked(store.listSessionMessages).mockResolvedValue([messageFixture]);
    vi.mocked(store.createRetryJob).mockResolvedValue({
      session: sessionFixture,
      job: retryJob,
    });
    vi.mocked(store.startJobExecution).mockResolvedValue(runningRetry);
    const { manager, execution } = createManager(store, 1_000);

    const retry = await manager.retryJob({
      failedJobId: 'job_1',
      clientRequestId: 'retry_request',
    });

    expect(retry.job).toBe(runningRetry);
    expect(retry).not.toHaveProperty('message');
    expect(store.createRetryJob).toHaveBeenCalledWith(expect.objectContaining({
      retryOfJobId: 'job_1',
      jobId: 'job_2',
      jobMetadata: expect.objectContaining({ goalMessageId: 'message_1' }),
    }));
    expect(store.createJobAndAppendUserMessage).not.toHaveBeenCalled();
    expect(execution.startExecution).toHaveBeenCalledWith('job_2');
  });

  it('continues as a new Job with a distinct committed user message', async () => {
    const store = createStore();
    const failedJob = jobFixture({ status: 'failed', version: 2, completedAtMs: 900 });
    const continuation = jobFixture({ id: 'job_2', retryOfJobId: 'job_1' });
    const message = messageFixtureFor(continuation);
    const running = jobFixture({
      ...continuation,
      status: 'running',
      version: 1,
      attemptNo: 1,
      currentAttemptId: 'attempt_1',
      leaseOwner: 'worker_1',
      leaseExpiresAtMs: 31_000,
    });
    vi.mocked(store.getJob).mockResolvedValue(failedJob);
    vi.mocked(store.listSessionMessages).mockResolvedValue([messageFixture]);
    vi.mocked(store.createJobAndAppendUserMessage).mockResolvedValue({
      session: sessionFixture,
      job: continuation,
      message,
    });
    vi.mocked(store.startJobExecution).mockResolvedValue(running);
    const { manager, execution } = createManager(store, 1_000);

    await expect(manager.continueAsNewJob({
      failedJobId: failedJob.id,
      clientRequestId: 'continue_request',
      message: 'Use a different implementation.',
    })).resolves.toMatchObject({ job: running, message });

    expect(store.createJobAndAppendUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      retryOfJobId: failedJob.id,
      content: 'Use a different implementation.',
      userMessageId: 'message_2',
    }));
    expect(store.createRetryJob).not.toHaveBeenCalled();
    expect(execution.startExecution).toHaveBeenCalledWith(running.id);
  });

  it('persists cancellation before aborting its active execution', async () => {
    const order: string[] = [];
    const cancelled = jobFixture({
      status: 'cancelled',
      version: 2,
      completedAtMs: 1_000,
    });
    const store = createStore();
    vi.mocked(store.cancelJob).mockImplementation(async () => {
      order.push('persisted');
      return cancelled;
    });
    const execution = executionSupervisor({
      abortExecution: vi.fn(() => { order.push('aborted'); }),
    });
    const { manager } = createManager(store, 1_000, execution);

    await expect(manager.cancelJob('job_1', 1)).resolves.toBe(cancelled);

    expect(order).toEqual(['persisted', 'aborted']);
  });

  it('resumes a recovery-required Job only after an explicit request', async () => {
    const store = createStore();
    const paused = jobFixture({
      status: 'recovery_required',
      version: 2,
    });
    const running = jobFixture({
      status: 'running',
      version: 3,
      attemptNo: 2,
      currentAttemptId: 'attempt_1',
      leaseOwner: 'worker_1',
      leaseExpiresAtMs: 31_000,
    });
    vi.mocked(store.getJob).mockResolvedValue(paused);
    vi.mocked(store.startJobExecution).mockResolvedValue(running);
    vi.mocked(store.prepareToolInvocationsForRecovery).mockResolvedValue({
      invocations: [],
      blockedInvocations: [],
    });
    const { manager, execution } = createManager(store, 1_000);

    await expect(manager.resumeJob(paused.id, paused.version)).resolves.toBe(running);

    expect(store.startJobExecution).toHaveBeenCalledWith(expect.objectContaining({
      jobId: paused.id,
      expectedVersion: paused.version,
      workerId: 'worker_1',
      attemptId: 'attempt_1',
    }));
    expect(execution.startExecution).toHaveBeenCalledWith(running.id);
  });

  it('blocks automatic recovery of an interrupted side-effecting tool', async () => {
    const store = createStore();
    const paused = jobFixture({ status: 'recovery_required', version: 2 });
    const running = jobFixture({
      status: 'running',
      version: 3,
      attemptNo: 2,
      currentAttemptId: 'attempt_1',
      leaseOwner: 'worker_1',
      leaseExpiresAtMs: 31_000,
    });
    const blockedInvocation = invocationFixture();
    const failed = jobFixture({
      status: 'failed',
      version: 4,
      attemptNo: 2,
      currentAttemptId: 'attempt_1',
      leaseOwner: 'worker_1',
      completedAtMs: 1_000,
    });
    vi.mocked(store.getJob).mockResolvedValue(paused);
    vi.mocked(store.startJobExecution).mockResolvedValue(running);
    vi.mocked(store.prepareToolInvocationsForRecovery).mockResolvedValue({
      invocations: [],
      blockedInvocations: [blockedInvocation],
    });
    vi.mocked(store.failJob).mockResolvedValue(failed);
    const { manager, execution } = createManager(store, 1_000);

    await expect(manager.resumeJob(paused.id, paused.version)).resolves.toBe(failed);

    expect(store.failJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: running.id,
      attemptId: running.currentAttemptId,
      error: expect.objectContaining({ code: 'unsafe_tool_recovery' }),
    }));
    expect(execution.startExecution).not.toHaveBeenCalled();
  });

  it('dispatches a HITL-resumed Job without starting a duplicate attempt', async () => {
    const store = createStore();
    const running = jobFixture({
      status: 'running',
      version: 3,
      attemptNo: 2,
      currentAttemptId: 'attempt_1',
      leaseOwner: 'worker_1',
      leaseExpiresAtMs: 31_000,
    });
    const request: AgentUserInputRequest = {
      id: 'input_1',
      sessionId: 'session_1',
      jobId: running.id,
      source: 'agent',
      answerMode: 'as_user_message',
      status: 'answered',
      prompt: 'Continue?',
      inputSchema: { type: 'approval' },
      answer: true,
      answerMessageId: 'message_2',
      clientAnswerId: 'answer_1',
      version: 1,
      createdAtMs: 100,
      updatedAtMs: 1_000,
      answeredAtMs: 1_000,
    };
    const answerMessage: AgentMessage = {
      ...messageFixture,
      id: 'message_2',
      jobId: running.id,
      content: 'true',
    };
    vi.mocked(store.saveUserInputAnswerAndResumeIfReady).mockResolvedValue({
      request,
      answerMessage,
      job: running,
      shouldResume: true,
      attemptId: running.currentAttemptId,
    });
    const { manager, execution } = createManager(store, 1_000);

    await manager.answerUserInputRequest({
      requestId: request.id,
      expectedVersion: 0,
      clientAnswerId: 'answer_1',
      answer: true,
    });

    expect(store.saveUserInputAnswerAndResumeIfReady).toHaveBeenCalledOnce();
    expect(store.startJobExecution).not.toHaveBeenCalled();
    expect(execution.startExecution).toHaveBeenCalledWith(running.id);
  });

  it('maps a stale start version into a stable runtime error', async () => {
    const store = createStore();
    const createdJob = jobFixture({ id: 'job_2' });
    vi.mocked(store.createJobAndAppendUserMessage).mockResolvedValue({
      session: sessionFixture,
      job: createdJob,
      message: messageFixtureFor(createdJob),
    });
    vi.mocked(store.startJobExecution).mockRejectedValue(new AgentStoreError(
      'CONCURRENCY_CONFLICT',
      'stale'
    ));
    const { manager } = createManager(store, 1_000);

    await expect(manager.createJob({
      sessionId: 'session_1',
      message: 'hello',
      clientRequestId: 'request_1',
    })).rejects.toMatchObject({
      code: 'concurrency_conflict',
      retryable: false,
    });
  });
});

describe('execution limits', () => {
  it('requires heartbeat to be shorter than the Job execution ownership window', () => {
    expect(() => resolveExecutionLimits({ jobLeaseMs: 10_000, jobHeartbeatMs: 10_000 }))
      .toThrow(/shorter/);
    expect(resolveExecutionLimits({ jobLeaseMs: 20_000, jobHeartbeatMs: 5_000 }))
      .toMatchObject({ jobLeaseMs: 20_000, jobHeartbeatMs: 5_000 });
  });
});

function createManager(
  store: AgentStore,
  nowMs: number,
  execution = executionSupervisor()
): { manager: JobManager; execution: JobExecutorPort } {
  const jobStore = new JobStore({
    store,
    workerId: 'worker_1',
    jobLeaseMs: 30_000,
    clock: { nowMs: () => nowMs },
    ids: {
      jobId: () => 'job_2',
      messageId: () => 'message_2',
      attemptId: () => 'attempt_1',
    },
  });
  return {
    manager: new JobManager({
      jobStore,
      publisher: { publish: vi.fn(async () => undefined) },
      execution,
    }),
    execution,
  };
}

function executionSupervisor(
  overrides: Partial<JobExecutorPort> = {}
): JobExecutorPort {
  return {
    start: vi.fn(async () => undefined),
    startExecution: vi.fn(async () => undefined),
    abortExecution: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  };
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

function jobFixture(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job_1',
    sessionId: 'session_1',
    status: 'created',
    attemptNo: 0,
    version: 0,
    createdAtMs: 2,
    updatedAtMs: 2,
    ...overrides,
  };
}

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

function messageFixtureFor(job: AgentJob): AgentMessage {
  return {
    ...messageFixture,
    jobId: job.id,
    id: job.id === 'job_1' ? 'message_1' : 'message_2',
  };
}

function invocationFixture(): AgentToolInvocation {
  return {
    id: 'invocation_1',
    sessionId: 'session_1',
    jobId: 'job_1',
    attemptId: 'attempt_old',
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
