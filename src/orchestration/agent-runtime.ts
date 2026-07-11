import { randomUUID } from 'node:crypto';
import type { AgentJob, AgentRealtimeEvent } from '../domain/index.js';
import { JobCoordinator } from '../runtime/job-coordinator.js';
import type { RuntimeEventPublisher } from '../runtime/runtime-event-writer.js';
import type { AgentStore } from '../storage/agent-store.js';
import { SessionView } from '../view/session-view.js';
import { projectSensitiveAnswers } from '../view/session-view.js';

export interface JobExecutionService {
  execute(jobId: string): Promise<void>;
}

export interface AgentRuntimeOptions {
  store: AgentStore;
  workerId: string;
  jobLeaseMs?: number;
  publisher: RuntimeEventPublisher;
  executor: JobExecutionService;
  removeSessionWorkspace?: (sessionId: string) => Promise<void>;
  clock?: { nowMs(): number };
  ids?: {
    sessionId(): string;
    jobId(): string;
    messageId(): string;
    attemptId(): string;
  };
}

export class AgentRuntime {
  readonly #store: AgentStore;
  readonly #publisher: RuntimeEventPublisher;
  readonly #executor: JobExecutionService;
  readonly #removeSessionWorkspace?: (sessionId: string) => Promise<void>;
  readonly #clock: { nowMs(): number };
  readonly #ids: NonNullable<AgentRuntimeOptions['ids']>;
  readonly #coordinator: JobCoordinator;
  readonly #view: SessionView;

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#publisher = options.publisher;
    this.#executor = options.executor;
    this.#removeSessionWorkspace = options.removeSessionWorkspace;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#ids = options.ids ?? randomRuntimeIds;
    this.#coordinator = new JobCoordinator({
      store: options.store,
      workerId: options.workerId,
      clock: this.#clock,
      limits: options.jobLeaseMs ? {
        jobLeaseMs: options.jobLeaseMs,
        jobHeartbeatMs: Math.max(1, Math.floor(options.jobLeaseMs / 3)),
      } : undefined,
      ids: {
        jobId: this.#ids.jobId,
        messageId: this.#ids.messageId,
        attemptId: this.#ids.attemptId,
      },
    });
    this.#view = new SessionView(options.store, this.#clock);
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

  async deleteSession(sessionId: string) {
    const deleted = await this.#store.deleteSession(sessionId);
    if (deleted) await this.#removeSessionWorkspace?.(sessionId);
    return deleted;
  }

  async createJob(input: {
    sessionId: string;
    message: string;
    clientRequestId: string;
  }) {
    const created = await this.#coordinator.createJob({
      sessionId: input.sessionId,
      content: input.message,
      clientRequestId: input.clientRequestId,
    });
    await this.#publishMany([
      { type: 'job.upserted', sessionId: input.sessionId, job: created.job },
      { type: 'message.upserted', sessionId: input.sessionId, message: created.message },
    ]);
    if (created.job.status === 'created') {
      const claimed = await this.#coordinator.claimJob(created.job.id, created.job.version);
      await this.#publishMany([{ type: 'job.upserted', sessionId: input.sessionId, job: claimed }]);
      this.#schedule(claimed.id);
      return { ...created, job: claimed };
    }
    return created;
  }

  async cancelJob(jobId: string, expectedVersion: number) {
    const job = await this.#coordinator.cancelJob(jobId, expectedVersion);
    await this.#publishMany([{ type: 'job.upserted', sessionId: job.sessionId, job }]);
    return job;
  }

  async retryJob(input: { failedJobId: string; clientRequestId: string; message?: string }) {
    const created = await this.#coordinator.retryJob({
      failedJobId: input.failedJobId,
      clientRequestId: input.clientRequestId,
      content: input.message,
    });
    await this.#publishMany([
      { type: 'job.upserted', sessionId: created.job.sessionId, job: created.job },
      ...('message' in created
        ? [{
            type: 'message.upserted' as const,
            sessionId: created.job.sessionId,
            message: created.message,
          }]
        : []),
    ]);
    const claimed = await this.#coordinator.claimJob(created.job.id, created.job.version);
    await this.#publishMany([{
      type: 'job.upserted', sessionId: claimed.sessionId, job: claimed,
    }]);
    this.#schedule(claimed.id);
    return { ...created, job: claimed };
  }

  async answerInput(input: {
    requestId: string;
    expectedVersion: number;
    clientAnswerId: string;
    answer: unknown;
  }) {
    const result = await this.#coordinator.answerInput(input);
    const projected = projectSensitiveAnswers(
      [result.answerMessage],
      result.invocation ? [result.invocation] : [],
      [result.request]
    );
    await this.#publishMany([
      { type: 'message.upserted', sessionId: result.job.sessionId, message: projected.messages[0]! },
      ...(projected.invocations[0] ? [{
        type: 'tool_invocation.upserted' as const,
        sessionId: result.job.sessionId,
        invocation: projected.invocations[0],
      }] : []),
      { type: 'user_input.upserted', sessionId: result.job.sessionId, request: projected.requests[0]! },
      { type: 'job.upserted', sessionId: result.job.sessionId, job: result.job },
    ]);
    if (result.shouldResume) this.#schedule(result.job.id);
    return result;
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

  #schedule(jobId: string): void {
    void this.#executor.execute(jobId).catch(() => {
      // The executor persists terminal failure when it still owns the lease.
    });
  }
}

const randomRuntimeIds = {
  sessionId: () => `session_${randomUUID()}`,
  jobId: () => `job_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  attemptId: () => `attempt_${randomUUID()}`,
};
