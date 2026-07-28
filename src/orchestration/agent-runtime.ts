import { createHash, randomUUID } from 'node:crypto';
import { AGENT_REQUEST_LIMITS, assertAgentRequestText } from '../domain/index.js';
import type { TaskManagerPort } from './tasks/task-manager.js';
import { AgentStoreError, type AgentStore } from '../storage/agent-store.js';
import { RuntimeError } from '../runtime/errors/runtime-error.js';
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
    sessionIdFromClientRequestId?(clientRequestId: string): string;
  };
}

export class AgentRuntime {
  readonly #store: AgentStore;
  readonly #tasks: TaskManagerPort;
  readonly #removeSessionWorkspace?: (sessionId: string) => Promise<void>;
  readonly #beforeDeleteSession?: (sessionId: string) => Promise<void>;
  readonly #clock: { nowMs(): number };
  readonly #ids: {
    sessionId(): string;
    sessionIdFromClientRequestId(clientRequestId: string): string;
  };
  readonly #view: SessionView;

  constructor(options: AgentRuntimeOptions) {
    this.#store = options.store;
    this.#tasks = options.tasks;
    this.#removeSessionWorkspace = options.removeSessionWorkspace;
    this.#beforeDeleteSession = options.beforeDeleteSession;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#ids = { ...randomRuntimeIds, ...options.ids };
    this.#view = new SessionView(options.store, this.#clock, options.processReader);
  }

  async createSession(input: { title?: string; clientRequestId?: string }) {
    assertAgentRequestText(
      input.title,
      'title',
      AGENT_REQUEST_LIMITS.sessionTitleCharacters,
      { optional: true }
    );
    assertAgentRequestText(
      input.clientRequestId,
      'clientRequestId',
      AGENT_REQUEST_LIMITS.idempotencyKeyCharacters,
      { optional: true }
    );
    const sessionId = input.clientRequestId === undefined
      ? this.#ids.sessionId()
      : this.#ids.sessionIdFromClientRequestId(input.clientRequestId);
    try {
      return await this.#store.sessions.create({
        id: sessionId,
        title: input.title,
        nowMs: this.#clock.nowMs(),
      });
    } catch (error) {
      if (!(error instanceof AgentStoreError)
        || error.code !== 'SESSION_ALREADY_EXISTS'
        || input.clientRequestId === undefined) {
        throw error;
      }
      const session = await this.#store.sessions.get(sessionId);
      if (!session) {
        throw new RuntimeError(
          'storage_error',
          'Idempotent Session replay could not load its committed entity.'
        );
      }
      if (session.title !== input.title) {
        throw new RuntimeError(
          'idempotency_conflict',
          `clientRequestId ${JSON.stringify(input.clientRequestId)} was reused with a different request.`,
          { details: { sessionId, clientRequestId: input.clientRequestId } }
        );
      }
      return session;
    }
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
    assertAgentRequestText(
      input.message,
      'message',
      AGENT_REQUEST_LIMITS.taskMessageCharacters
    );
    assertAgentRequestText(
      input.clientRequestId,
      'clientRequestId',
      AGENT_REQUEST_LIMITS.idempotencyKeyCharacters
    );
    return this.#tasks.createTask(input);
  }

  async cancelTask(taskId: string, expectedVersion: number) {
    return this.#tasks.cancelTask(taskId, expectedVersion);
  }

  async retryTask(input: { sourceTaskId: string; clientRequestId: string }) {
    assertAgentRequestText(
      input.clientRequestId,
      'clientRequestId',
      AGENT_REQUEST_LIMITS.idempotencyKeyCharacters
    );
    return this.#tasks.retryTask(input);
  }

  async continueAsNewTask(input: {
    sourceTaskId: string;
    clientRequestId: string;
    message: string;
  }) {
    assertAgentRequestText(
      input.message,
      'message',
      AGENT_REQUEST_LIMITS.taskMessageCharacters
    );
    assertAgentRequestText(
      input.clientRequestId,
      'clientRequestId',
      AGENT_REQUEST_LIMITS.idempotencyKeyCharacters
    );
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
    assertAgentRequestText(
      input.clientAnswerId,
      'clientAnswerId',
      AGENT_REQUEST_LIMITS.idempotencyKeyCharacters
    );
    return this.#tasks.answerUserInputRequest(input);
  }
}

const randomRuntimeIds = {
  sessionId: () => `session_${randomUUID()}`,
  sessionIdFromClientRequestId: (clientRequestId: string) => (
    `session_${createHash('sha256').update(clientRequestId).digest('hex').slice(0, 32)}`
  ),
};
