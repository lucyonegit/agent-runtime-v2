import { createHash } from 'node:crypto';
import { mapStoredMessagesToChatMessages } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ContextConfig } from '../config/runtime-config.js';
import {
  ACTIVE_TASK_STATUSES,
  type AgentModelCall,
  type AgentTask,
} from '../domain/index.js';
import { ModelInputBuilder } from '../runtime/context/model-input-builder.js';
import type { ModelInput } from '../runtime/context/types/model-input.types.js';
import { RuntimeError } from '../runtime/errors/runtime-error.js';
import { stableStringify } from '../runtime/helpers/stable-json.helper.js';
import type { AgentStore } from '../storage/agent-store.js';
import { AgentStoreError } from '../storage/agent-store.js';

export type ContextQuery =
  | { kind: 'next_turn'; sessionId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'model_call'; modelCallId: string };

export interface ContextSnapshot {
  query: ContextQuery;
  generatedAtMs: number;
  sessionId: string;
  basedOnLatestTaskId?: string;
  systemPromptVersion: string;
  contextWindowTokens: number;
  outputTokenLimit: number;
  input: ModelInput;
  verification: { status: 'reconstructed' | 'exact'; checksumMatched?: boolean };
}

export interface ContextInspectionServiceOptions {
  store: AgentStore;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  systemPromptVersion: string;
  promptId: string;
  promptVersion: number;
  contextWindowTokens: number;
  outputTokenLimit: number;
  inputTokenLimit: number;
  getStableContext(sessionId: string): string | Promise<string>;
  contextConfig: ContextConfig;
  clock?: { nowMs(): number };
}

/** Read-only reconstruction built by the same ModelInputBuilder used for execution. */
export class ContextInspectionService {
  readonly #builder: ModelInputBuilder;
  readonly #clock: { nowMs(): number };

  constructor(private readonly options: ContextInspectionServiceOptions) {
    this.#builder = new ModelInputBuilder({
      store: options.store,
      systemPrompt: options.systemPrompt,
      systemPromptVersion: options.systemPromptVersion,
      promptId: options.promptId,
      promptVersion: options.promptVersion,
      inputTokenLimit: options.inputTokenLimit,
      reservedOutputTokens: options.outputTokenLimit,
      contextConfig: options.contextConfig,
      toolSchemas: options.tools,
      getStableContext: options.getStableContext,
    });
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async inspect(query: ContextQuery): Promise<ContextSnapshot> {
    if (query.kind === 'model_call') return this.#modelCall(query);
    if (query.kind === 'task') {
      const task = await this.#requireTask(query.taskId);
      return this.#snapshot(query, task.sessionId, await this.#builder.previewTask(task), task.id);
    }

    const session = await this.options.store.sessions.get(query.sessionId);
    if (!session) {
      throw new AgentStoreError(
        'SESSION_NOT_FOUND',
        `Agent session ${JSON.stringify(query.sessionId)} was not found.`
      );
    }
    const tasks = await this.options.store.sessions.listTasks(query.sessionId);
    assertNoActiveTask(tasks);
    const latestTask = [...tasks].sort((left, right) => right.createdAtMs - left.createdAtMs)[0];
    if (!latestTask) {
      throw new RuntimeError('invalid_task_state', `Session ${query.sessionId} has no Task to inspect.`);
    }
    const input = await this.#builder.previewTask(latestTask);
    assertNoActiveTask(await this.options.store.sessions.listTasks(query.sessionId));
    return this.#snapshot(query, session.id, input, latestTask.id);
  }

  async #modelCall(
    query: Extract<ContextQuery, { kind: 'model_call' }>
  ): Promise<ContextSnapshot> {
    const call = await this.options.store.models.getCall(query.modelCallId);
    if (!call) throw new Error(`ModelCall ${JSON.stringify(query.modelCallId)} was not found.`);
    return {
      ...this.#snapshot(query, call.sessionId, reconstructRecordedModelCall(call), call.taskId),
      contextWindowTokens: call.maxContextTokens,
      outputTokenLimit: call.reservedOutputTokens,
      verification: { status: 'exact', checksumMatched: true },
    };
  }

  async #requireTask(taskId: string): Promise<AgentTask> {
    const task = await this.options.store.tasks.get(taskId);
    if (!task) throw new Error(`Task ${JSON.stringify(taskId)} was not found.`);
    return task;
  }

  #snapshot(
    query: ContextQuery,
    sessionId: string,
    input: ModelInput,
    basedOnLatestTaskId?: string
  ): ContextSnapshot {
    return {
      query,
      generatedAtMs: this.#clock.nowMs(),
      sessionId,
      ...(basedOnLatestTaskId ? { basedOnLatestTaskId } : {}),
      systemPromptVersion: input.inputManifest.systemPromptVersion,
      contextWindowTokens: this.options.contextWindowTokens,
      outputTokenLimit: this.options.outputTokenLimit,
      input,
      verification: { status: 'reconstructed' },
    };
  }
}

const ACTIVE_TASK_STATUS_SET = new Set<AgentTask['status']>(ACTIVE_TASK_STATUSES);

function assertNoActiveTask(tasks: AgentTask[]): void {
  const active = [...tasks]
    .filter(task => ACTIVE_TASK_STATUS_SET.has(task.status))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  if (!active) return;
  throw new RuntimeError(
    'concurrency_conflict',
    `Context preview is unavailable while Task ${JSON.stringify(active.id)} is ${active.status}.`,
    { details: { taskId: active.id, status: active.status } }
  );
}

function reconstructRecordedModelCall(call: AgentModelCall): ModelInput {
  const serialized = stableStringify(call.inputMessages);
  const checksum = createHash('sha256').update(serialized).digest('hex');
  if (checksum !== call.inputChecksum) {
    throw new ContextSnapshotUnreconstructableError(
      `ModelCall ${JSON.stringify(call.id)} persisted input checksum is invalid.`
    );
  }
  return {
    messages: mapStoredMessagesToChatMessages(call.inputMessages),
    estimatedTokens: call.estimatedInputTokens,
    inputTokenLimit: call.maxContextTokens - call.reservedOutputTokens,
    includedMessageIds: [],
    projectedToolResultMessageIds:
      call.inputManifest.truncatedToolResultMessageIds ?? [],
    inputManifest: call.inputManifest,
  };
}

class ContextSnapshotUnreconstructableError extends Error {
  readonly code = 'context_snapshot_unreconstructable';

  constructor(message: string) {
    super(message);
    this.name = 'ContextSnapshotUnreconstructableError';
  }
}
