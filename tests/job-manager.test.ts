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
import { JobActions } from '../src/orchestration/jobs/shared/job-actions.js';
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
    vi.mocked(store.jobs.createWithUserMessage).mockResolvedValue({
      session: sessionFixture,
      job: createdJob,
      message,
    });
    vi.mocked(store.jobs.startExecution).mockResolvedValue(runningJob);
    const { manager, execution } = createManager(store, 1_000);

    await expect(manager.createJob({
      sessionId: 'session_1',
      message: 'hello',
      clientRequestId: 'request_1',
    })).resolves.toMatchObject({ job: runningJob, message });

    expect(store.jobs.startExecution).toHaveBeenCalledWith({
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
    vi.mocked(store.jobs.createWithUserMessage).mockRejectedValue(new AgentStoreError(
      'CLIENT_REQUEST_CONFLICT',
      'duplicate request'
    ));
    vi.mocked(store.sessions.get).mockResolvedValue(sessionFixture);
    vi.mocked(store.jobs.getByClientRequestId).mockResolvedValue(completedJob);
    vi.mocked(store.sessions.listMessages).mockResolvedValue([committedMessage]);
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
    expect(store.jobs.startExecution).not.toHaveBeenCalled();
    expect(execution.startExecution).not.toHaveBeenCalled();
  });

  it('rejects client request reuse with a different payload', async () => {
    const store = createStore();
    vi.mocked(store.jobs.createWithUserMessage).mockRejectedValue(new AgentStoreError(
      'CLIENT_REQUEST_CONFLICT',
      'duplicate request'
    ));
    vi.mocked(store.sessions.get).mockResolvedValue(sessionFixture);
    vi.mocked(store.jobs.getByClientRequestId).mockResolvedValue(jobFixture({ id: 'job_2' }));
    vi.mocked(store.sessions.listMessages).mockResolvedValue([
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
    vi.mocked(store.jobs.get).mockResolvedValue(failedJob);
    vi.mocked(store.sessions.listMessages).mockResolvedValue([messageFixture]);
    vi.mocked(store.jobs.createRetry).mockResolvedValue({
      session: sessionFixture,
      job: retryJob,
    });
    vi.mocked(store.jobs.startExecution).mockResolvedValue(runningRetry);
    const { manager, execution } = createManager(store, 1_000);

    const retry = await manager.retryJob({
      failedJobId: 'job_1',
      clientRequestId: 'retry_request',
    });

    expect(retry.job).toBe(runningRetry);
    expect(retry).not.toHaveProperty('message');
    expect(store.jobs.createRetry).toHaveBeenCalledWith(expect.objectContaining({
      retryOfJobId: 'job_1',
      jobId: 'job_2',
      jobMetadata: expect.objectContaining({ goalMessageId: 'message_1' }),
    }));
    expect(store.jobs.createWithUserMessage).not.toHaveBeenCalled();
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
    vi.mocked(store.jobs.get).mockResolvedValue(failedJob);
    vi.mocked(store.sessions.listMessages).mockResolvedValue([messageFixture]);
    vi.mocked(store.jobs.createWithUserMessage).mockResolvedValue({
      session: sessionFixture,
      job: continuation,
      message,
    });
    vi.mocked(store.jobs.startExecution).mockResolvedValue(running);
    const { manager, execution } = createManager(store, 1_000);

    await expect(manager.continueAsNewJob({
      failedJobId: failedJob.id,
      clientRequestId: 'continue_request',
      message: 'Use a different implementation.',
    })).resolves.toMatchObject({ job: running, message });

    expect(store.jobs.createWithUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      retryOfJobId: failedJob.id,
      content: 'Use a different implementation.',
      userMessageId: 'message_2',
    }));
    expect(store.jobs.createRetry).not.toHaveBeenCalled();
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
    vi.mocked(store.jobs.cancel).mockImplementation(async () => {
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
    vi.mocked(store.jobs.get).mockResolvedValue(paused);
    vi.mocked(store.jobs.startExecution).mockResolvedValue(running);
    vi.mocked(store.execution.prepareToolsForRecovery).mockResolvedValue({
      invocations: [],
      blockedInvocations: [],
    });
    const { manager, execution } = createManager(store, 1_000);

    await expect(manager.resumeJob(paused.id, paused.version)).resolves.toBe(running);

    expect(store.jobs.startExecution).toHaveBeenCalledWith(expect.objectContaining({
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
    vi.mocked(store.jobs.get).mockResolvedValue(paused);
    vi.mocked(store.jobs.startExecution).mockResolvedValue(running);
    vi.mocked(store.execution.prepareToolsForRecovery).mockResolvedValue({
      invocations: [],
      blockedInvocations: [blockedInvocation],
    });
    vi.mocked(store.jobs.fail).mockResolvedValue(failed);
    const { manager, execution } = createManager(store, 1_000);

    await expect(manager.resumeJob(paused.id, paused.version)).resolves.toBe(failed);

    expect(store.jobs.fail).toHaveBeenCalledWith(expect.objectContaining({
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
    vi.mocked(store.execution.answerUserInput).mockResolvedValue({
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

    expect(store.execution.answerUserInput).toHaveBeenCalledOnce();
    expect(store.jobs.startExecution).not.toHaveBeenCalled();
    expect(execution.startExecution).toHaveBeenCalledWith(running.id);
  });

  it('maps a stale start version into a stable runtime error', async () => {
    const store = createStore();
    const createdJob = jobFixture({ id: 'job_2' });
    vi.mocked(store.jobs.createWithUserMessage).mockResolvedValue({
      session: sessionFixture,
      job: createdJob,
      message: messageFixtureFor(createdJob),
    });
    vi.mocked(store.jobs.startExecution).mockRejectedValue(new AgentStoreError(
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
  const jobActions = new JobActions({
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
      jobActions,
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
    sessions: {
      create: vi.fn<AgentStore['sessions']['create']>(),
      list: vi.fn<AgentStore['sessions']['list']>(),
      delete: vi.fn<AgentStore['sessions']['delete']>(),
      get: vi.fn<AgentStore['sessions']['get']>(),
      listMessages: vi.fn<AgentStore['sessions']['listMessages']>(),
      listJobs: vi.fn<AgentStore['sessions']['listJobs']>(),
      listPlans: vi.fn<AgentStore['sessions']['listPlans']>(),
      listPlanSteps: vi.fn<AgentStore['sessions']['listPlanSteps']>(),
      listToolInvocations: vi.fn<AgentStore['sessions']['listToolInvocations']>(),
      listArtifacts: vi.fn<AgentStore['sessions']['listArtifacts']>(),
      listUserInputRequests: vi.fn<AgentStore['sessions']['listUserInputRequests']>(),
    },
    jobs: {
      get: vi.fn<AgentStore['jobs']['get']>(),
      getByClientRequestId: vi.fn<AgentStore['jobs']['getByClientRequestId']>(),
      listNeedingRecovery: vi.fn<AgentStore['jobs']['listNeedingRecovery']>(),
      markRecoveryRequired: vi.fn<AgentStore['jobs']['markRecoveryRequired']>(),
      createWithUserMessage: vi.fn<AgentStore['jobs']['createWithUserMessage']>(),
      createRetry: vi.fn<AgentStore['jobs']['createRetry']>(),
      startExecution: vi.fn<AgentStore['jobs']['startExecution']>(),
      renewExecutionOwnership: vi.fn<AgentStore['jobs']['renewExecutionOwnership']>(),
      fail: vi.fn<AgentStore['jobs']['fail']>(),
      cancel: vi.fn<AgentStore['jobs']['cancel']>(),
    },
    execution: {
      getToolInvocation: vi.fn<AgentStore['execution']['getToolInvocation']>(),
      getLatestLoopCheckpoint: vi.fn<AgentStore['execution']['getLatestLoopCheckpoint']>(),
      commitModelToolCalls: vi.fn<AgentStore['execution']['commitModelToolCalls']>(),
      tryStartTool: vi.fn<AgentStore['execution']['tryStartTool']>(),
      prepareToolsForRecovery: vi.fn<AgentStore['execution']['prepareToolsForRecovery']>(),
      commitToolResult: vi.fn<AgentStore['execution']['commitToolResult']>(),
      completeWithFinalMessage: vi.fn<AgentStore['execution']['completeWithFinalMessage']>(),
      waitForUserInput: vi.fn<AgentStore['execution']['waitForUserInput']>(),
      answerUserInput: vi.fn<AgentStore['execution']['answerUserInput']>(),
    },
    plans: {
      getByJobId: vi.fn<AgentStore['plans']['getByJobId']>(),
      listSteps: vi.fn<AgentStore['plans']['listSteps']>(),
      applyUpdate: vi.fn<AgentStore['plans']['applyUpdate']>(),
    },
    models: {
      getCall: vi.fn<AgentStore['models']['getCall']>(),
      listCalls: vi.fn<AgentStore['models']['listCalls']>(),
      listRecentSessionCalls: vi.fn<AgentStore['models']['listRecentSessionCalls']>(),
      getUsageStats: vi.fn<AgentStore['models']['getUsageStats']>(),
      startCall: vi.fn<AgentStore['models']['startCall']>(),
      completeCall: vi.fn<AgentStore['models']['completeCall']>(),
      setCallOutputDisposition: vi.fn<AgentStore['models']['setCallOutputDisposition']>(),
      abandonStartedCalls: vi.fn<AgentStore['models']['abandonStartedCalls']>(),
    },
    context: {
      listActiveSummaries: vi.fn<AgentStore['context']['listActiveSummaries']>(),
      getSummariesByIds: vi.fn<AgentStore['context']['getSummariesByIds']>(),
      replaceSummary: vi.fn<AgentStore['context']['replaceSummary']>(),
    },
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
