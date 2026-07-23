import { randomUUID } from 'node:crypto';
import type { AgentJob, AgentRealtimeEvent } from '../domain/index.js';
import {
  type JobExecutionController,
} from './job-execution-manager.js';
import { JobLifecycle } from './job-lifecycle.js';
import type { RuntimeEventPublisher } from '../runtime/runtime-event-writer.js';
import type { AgentStore } from '../storage/agent-store.js';
import { RuntimeError } from '../runtime/runtime-errors.js';
import { SessionView, type SessionProcessReader } from '../view/session-view.js';
import { projectSensitiveAnswers } from '../view/session-view.js';

export interface AgentRuntimeOptions {
  store: AgentStore;
  jobLifecycle: JobLifecycle;
  publisher: RuntimeEventPublisher;
  jobExecution: JobExecutionController;
  processReader?: SessionProcessReader;
  removeSessionWorkspace?: (sessionId: string) => Promise<void>;
  beforeDeleteSession?: (sessionId: string) => Promise<void>;
  clock?: { nowMs(): number };
  ids?: {
    sessionId(): string;
  };
}

export class AgentRuntime {
  readonly #store: AgentStore;
  readonly #publisher: RuntimeEventPublisher;
  readonly #jobExecution: JobExecutionController;
  readonly #removeSessionWorkspace?: (sessionId: string) => Promise<void>;
  readonly #beforeDeleteSession?: (sessionId: string) => Promise<void>;
  readonly #clock: { nowMs(): number };
  readonly #ids: NonNullable<AgentRuntimeOptions['ids']>;
  readonly #jobLifecycle: JobLifecycle;
  readonly #view: SessionView;

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#publisher = options.publisher;
    this.#jobExecution = options.jobExecution;
    this.#removeSessionWorkspace = options.removeSessionWorkspace;
    this.#beforeDeleteSession = options.beforeDeleteSession;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#ids = options.ids ?? randomRuntimeIds;
    this.#jobLifecycle = options.jobLifecycle;
    this.#view = new SessionView(options.store, this.#clock, options.processReader);
  }

  async createSession(input: { title?: string }) {
    return this.#store.createSession({
      id: this.#ids.sessionId(),
      title: input.title,
      nowMs: this.#clock.nowMs(),
    });
  }

  listSessions() {
    return this.#store.listSessions();
  }

  getSessionView(sessionId: string) {
    return this.#view.load(sessionId);
  }

  async start(): Promise<void> {
    await this.#jobExecution.start();
  }

  async stop(): Promise<void> {
    await this.#jobExecution.shutdown();
  }

  async deleteSession(sessionId: string) {
    await this.#beforeDeleteSession?.(sessionId);
    const deleted = await this.#store.deleteSession(sessionId);
    if (deleted) await this.#removeSessionWorkspace?.(sessionId);
    return deleted;
  }

  async createJob(input: {
    sessionId: string;
    message: string;
    clientRequestId: string;
  }) {
    const creationResult = await this.#jobLifecycle.createJob({
      sessionId: input.sessionId,
      content: input.message,
      clientRequestId: input.clientRequestId,
    });
    await this.#publishMany([
      { type: 'job.upserted', sessionId: input.sessionId, job: creationResult.job },
      { type: 'message.upserted', sessionId: input.sessionId, message: creationResult.message },
    ]);
    if (creationResult.job.status === 'created') {
      const runningJob = await this.#jobLifecycle.startJobExecution(
        creationResult.job.id,
        creationResult.job.version
      );
      await this.#publishMany([{ type: 'job.upserted', sessionId: input.sessionId, job: runningJob }]);
      this.#startJobExecutionInBackground(runningJob.id);
      return { ...creationResult, job: runningJob };
    }
    return creationResult;
  }

  async cancelJob(jobId: string, expectedVersion: number) {
    const job = await this.#cancelUsingLatestVersion(jobId, expectedVersion);
    // Persist the terminal state before aborting I/O so every subsequent write
    // is rejected by the Job fence, even if a driver ignores AbortSignal.
    this.#jobExecution.cancelJobExecution(job.id);
    await this.#publishMany([{ type: 'job.upserted', sessionId: job.sessionId, job }]);
    return job;
  }

  async retryJob(input: { failedJobId: string; clientRequestId: string; message?: string }) {
    const retryResult = await this.#jobLifecycle.retryJob({
      failedJobId: input.failedJobId,
      clientRequestId: input.clientRequestId,
      content: input.message,
    });
    await this.#publishMany([
      { type: 'job.upserted', sessionId: retryResult.job.sessionId, job: retryResult.job },
      ...('message' in retryResult
        ? [{
            type: 'message.upserted' as const,
            sessionId: retryResult.job.sessionId,
            message: retryResult.message,
          }]
        : []),
    ]);
    const runningJob = await this.#jobLifecycle.startJobExecution(
      retryResult.job.id,
      retryResult.job.version
    );
    await this.#publishMany([{
      type: 'job.upserted', sessionId: runningJob.sessionId, job: runningJob,
    }]);
    this.#startJobExecutionInBackground(runningJob.id);
    return { ...retryResult, job: runningJob };
  }

  async resumeJob(jobId: string, expectedVersion: number): Promise<AgentJob> {
    const recoveredRunningJob = await this.#jobLifecycle.resumeJobExecution(jobId, expectedVersion);
    await this.#publishMany([{
      type: 'job.upserted',
      sessionId: recoveredRunningJob.sessionId,
      job: recoveredRunningJob,
    }]);

    const prepared = await this.#store.prepareToolInvocationsForRecovery({
      jobId: recoveredRunningJob.id,
      workerId: recoveredRunningJob.leaseOwner!,
      attemptId: recoveredRunningJob.currentAttemptId!,
      nowMs: this.#clock.nowMs(),
    });
    await this.#publishMany([
      ...prepared.invocations,
      ...prepared.blockedInvocations,
    ].map(invocation => ({
      type: 'tool_invocation.upserted' as const,
      sessionId: recoveredRunningJob.sessionId,
      invocation,
    })));
    if (prepared.blockedInvocations.length > 0) {
      const failedJob = await this.#jobLifecycle.failJob(recoveredRunningJob, {
        code: 'unsafe_tool_recovery',
        message: 'A side-effecting tool was interrupted after it started. Its outcome must be reconciled before retrying.',
        details: prepared.blockedInvocations.map(invocation => ({
          invocationId: invocation.id,
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          status: invocation.status,
          sideEffectLevel: invocation.sideEffectLevel,
        })),
      });
      await this.#publishMany([{
        type: 'job.upserted',
        sessionId: failedJob.sessionId,
        job: failedJob,
      }]);
      return failedJob;
    }
    this.#startJobExecutionInBackground(recoveredRunningJob.id);
    return recoveredRunningJob;
  }

  async answerUserInputRequest(input: {
    requestId: string;
    expectedVersion: number;
    clientAnswerId: string;
    answer: unknown;
  }) {
    const answerResult = await this.#jobLifecycle.answerUserInputRequest(input);
    const publicAnswer = projectSensitiveAnswers(
      [answerResult.answerMessage],
      answerResult.invocation ? [answerResult.invocation] : [],
      [answerResult.request]
    );
    await this.#publishMany([
      { type: 'message.upserted', sessionId: answerResult.job.sessionId, message: publicAnswer.messages[0]! },
      ...(publicAnswer.invocations[0] ? [{
        type: 'tool_invocation.upserted' as const,
        sessionId: answerResult.job.sessionId,
        invocation: publicAnswer.invocations[0],
      }] : []),
      { type: 'user_input.upserted', sessionId: answerResult.job.sessionId, request: publicAnswer.requests[0]! },
      { type: 'job.upserted', sessionId: answerResult.job.sessionId, job: answerResult.job },
    ]);
    if (answerResult.shouldResume) {
      this.#startJobExecutionInBackground(answerResult.job.id);
    }
    return answerResult;
  }

  async #publishMany(events: AgentRealtimeEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.#publisher.publish(event);
      } catch {
        // Full SessionView recovery is authoritative after a publish failure.
      }
    }
  }

  async #cancelUsingLatestVersion(jobId: string, expectedVersion: number): Promise<AgentJob> {
    try {
      return await this.#jobLifecycle.cancelJob(jobId, expectedVersion);
    } catch (error) {
      if (!(error instanceof RuntimeError && error.code === 'concurrency_conflict')) throw error;
      const latest = await this.#jobLifecycle.getJob(jobId);
      if (!latest) throw error;
      if (latest.status === 'cancelled') return latest;
      if (!['created', 'running', 'waiting_user_input', 'resuming', 'recovery_required'].includes(latest.status)) {
        throw error;
      }
      return this.#jobLifecycle.cancelJob(jobId, latest.version);
    }
  }

  #startJobExecutionInBackground(jobId: string): void {
    void this.#jobExecution.executeJob(jobId).catch(() => {
      // The execution manager persists terminal failure while it still owns the Job.
    });
  }
}

const randomRuntimeIds = {
  sessionId: () => `session_${randomUUID()}`,
};
