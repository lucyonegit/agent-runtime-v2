import { randomUUID } from 'node:crypto';
import type { TaskManagerPort } from './tasks/task-manager.js';
import type { AgentStore } from '../storage/agent-store.js';
import { SessionView, type SessionProcessReader } from '../view/session-view.js';

export interface AgentRuntimeOptions {
  store: AgentStore;
  tasks: TaskManagerPort;
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
  readonly #tasks: TaskManagerPort;
  readonly #removeSessionWorkspace?: (sessionId: string) => Promise<void>;
  readonly #beforeDeleteSession?: (sessionId: string) => Promise<void>;
  readonly #clock: { nowMs(): number };
  readonly #ids: NonNullable<AgentRuntimeOptions['ids']>;
  readonly #view: SessionView;

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#tasks = options.tasks;
    this.#removeSessionWorkspace = options.removeSessionWorkspace;
    this.#beforeDeleteSession = options.beforeDeleteSession;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#ids = options.ids ?? randomRuntimeIds;
    this.#view = new SessionView(options.store, this.#clock, options.processReader);
  }

  async createSession(input: { title?: string }) {
    return this.#store.sessions.create({
      id: this.#ids.sessionId(),
      title: input.title,
      nowMs: this.#clock.nowMs(),
    });
  }

  listSessions() {
    return this.#store.sessions.list();
  }

  getSessionView(sessionId: string) {
    return this.#view.load(sessionId);
  }

  async start(): Promise<void> {
    await this.#tasks.start();
  }

  async stop(): Promise<void> {
    await this.#tasks.shutdown();
  }

  async deleteSession(sessionId: string) {
    const existed = await this.#tasks.prepareSessionDeletion(sessionId);
    await this.#beforeDeleteSession?.(sessionId);
    await this.#removeSessionWorkspace?.(sessionId);
    const deleted = await this.#store.sessions.finalizeDeletion(sessionId);
    return existed || deleted;
  }

  async createTask(input: {
    sessionId: string;
    message: string;
    clientRequestId: string;
  }) {
    return this.#tasks.createTask(input);
  }

  async cancelTask(taskId: string, expectedVersion: number) {
    return this.#tasks.cancelTask(taskId, expectedVersion);
  }

  async retryTask(input: { sourceTaskId: string; clientRequestId: string }) {
    return this.#tasks.retryTask(input);
  }

  async continueAsNewTask(input: {
    sourceTaskId: string;
    clientRequestId: string;
    message: string;
  }) {
    return this.#tasks.continueAsNewTask(input);
  }

  async resumeTask(taskId: string, expectedVersion: number) {
    return this.#tasks.resumeTask(taskId, expectedVersion);
  }

  async answerUserInputRequest(input: {
    requestId: string;
    expectedVersion: number;
    clientAnswerId: string;
    answer: unknown;
  }) {
    return this.#tasks.answerUserInputRequest(input);
  }
}

const randomRuntimeIds = {
  sessionId: () => `session_${randomUUID()}`,
};
