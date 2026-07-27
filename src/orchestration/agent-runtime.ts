import { randomUUID } from 'node:crypto';
import type { JobManagerPort } from './jobs/job-manager.js';
import type { AgentStore } from '../storage/agent-store.js';
import { SessionView, type SessionProcessReader } from '../view/session-view.js';

export interface AgentRuntimeOptions {
  store: AgentStore;
  jobs: JobManagerPort;
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
  readonly #jobs: JobManagerPort;
  readonly #removeSessionWorkspace?: (sessionId: string) => Promise<void>;
  readonly #beforeDeleteSession?: (sessionId: string) => Promise<void>;
  readonly #clock: { nowMs(): number };
  readonly #ids: NonNullable<AgentRuntimeOptions['ids']>;
  readonly #view: SessionView;

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#jobs = options.jobs;
    this.#removeSessionWorkspace = options.removeSessionWorkspace;
    this.#beforeDeleteSession = options.beforeDeleteSession;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#ids = options.ids ?? randomRuntimeIds;
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
    await this.#jobs.start();
  }

  async stop(): Promise<void> {
    await this.#jobs.shutdown();
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
    return this.#jobs.createJob(input);
  }

  async cancelJob(jobId: string, expectedVersion: number) {
    return this.#jobs.cancelJob(jobId, expectedVersion);
  }

  async retryJob(input: { failedJobId: string; clientRequestId: string }) {
    return this.#jobs.retryJob(input);
  }

  async continueAsNewJob(input: {
    failedJobId: string;
    clientRequestId: string;
    message: string;
  }) {
    return this.#jobs.continueAsNewJob(input);
  }

  async resumeJob(jobId: string, expectedVersion: number) {
    return this.#jobs.resumeJob(jobId, expectedVersion);
  }

  async answerUserInputRequest(input: {
    requestId: string;
    expectedVersion: number;
    clientAnswerId: string;
    answer: unknown;
  }) {
    return this.#jobs.answerUserInputRequest(input);
  }
}

const randomRuntimeIds = {
  sessionId: () => `session_${randomUUID()}`,
};
