import { randomUUID } from 'node:crypto';
import type { AgentMessage, AgentRealtimeEvent, AgentTask } from '../../domain/index.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../loop/loop-events.js';
import type { RuntimeTool } from '../execution/tool-executor.js';
import type { AgentLoopTarget } from '../loop/agent-loop.js';
import type { AgentStore, FinishTaskResult } from '../../storage/agent-store.js';
import { mapStoreError } from '../errors/runtime-error.js';
import { LoopEventHandler } from './handlers/loop-event.handler.js';
import { taskFinishEvents } from './helpers/task-finish-events.js';

export { redactToolArguments } from './helpers/event-payload.helper.js';

export interface RuntimeEventPublisher {
  publish(event: AgentRealtimeEvent): void | Promise<void>;
}

export interface RuntimeEventWriterIds {
  eventId(): string;
  messageId(): string;
  toolCallId(): string;
  artifactId?(): string;
  userInputRequestId(): string;
}

export interface RuntimeEventWriterOptions {
  store: AgentStore;
  ownerId: string;
  tools: RuntimeTool[];
  publisher?: RuntimeEventPublisher;
  ids?: RuntimeEventWriterIds;
  clock?: { nowMs(): number };
  requireModelCallAudit?: boolean;
  onPublishError?: (error: unknown, event: AgentRealtimeEvent) => void;
}

export type RuntimeEventRecordResult =
  | { type: 'published_delta' }
  | { type: 'discarded_output' }
  | { type: 'committed_tool_calls'; message: AgentMessage }
  | { type: 'committed_tool_result'; message: AgentMessage }
  | { type: 'recovery_required'; task: AgentTask; message: AgentMessage }
  | { type: 'final_candidate'; event: Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted }> }
  | { type: 'input_required'; event: Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ToolInputRequired }> };

export class RuntimeEventWriter {
  readonly #ids: RuntimeEventWriterIds;
  readonly #clock: { nowMs(): number };
  readonly #messageIdsByOutput = new Map<string, string>();
  readonly #handler: LoopEventHandler;

  constructor(private readonly options: RuntimeEventWriterOptions) {
    this.#ids = options.ids ?? randomWriterIds;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#handler = new LoopEventHandler({
      store: options.store,
      ownerId: options.ownerId,
      tools: options.tools,
      ids: this.#ids,
      clock: this.#clock,
      requireModelCallAudit: options.requireModelCallAudit ?? false,
      messageId: (taskId, outputId) => this.#messageId(taskId, outputId),
      publish: event => this.#publish(event),
    });
  }

  record(event: LoopEvent, target: AgentLoopTarget): Promise<RuntimeEventRecordResult> {
    return this.#handler.record(event, target);
  }

  async completeFinal(
    event: Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted }>,
    target: AgentLoopTarget
  ): Promise<{ task: AgentTask; message: AgentMessage }> {
    if (event.toolCalls.length > 0) throw new TypeError('A tool-call output cannot be final.');
    try {
      const committed = await this.options.store.execution.completeTask({
        sessionId: target.sessionId,
        taskId: target.taskId,
        taskRunId: target.taskRunId,
        ownerId: this.options.ownerId,
        outputId: event.outputId,
        messageId: this.#messageId(target.taskId, event.outputId),
        content: event.content,
        nowMs: this.#clock.nowMs(),
      });
      await this.#publish({ type: 'message.upserted', sessionId: target.sessionId, message: committed.message });
      await this.publishTaskFinish(committed);
      return { task: committed.task, message: committed.message };
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async markWaitingForInput(
    events: Array<Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ToolInputRequired }>>,
    target: AgentLoopTarget
  ) {
    if (events.length === 0) throw new TypeError('Input waiting requires at least one event.');
    try {
      const committed = await this.options.store.execution.waitForUserInput({
        sessionId: target.sessionId,
        taskId: target.taskId,
        taskRunId: target.taskRunId,
        ownerId: this.options.ownerId,
        requests: events.map(event => ({
          requestId: this.#ids.userInputRequestId(),
          modelToolCallId: event.modelToolCallId,
          title: event.request.title,
          prompt: event.request.prompt,
          inputSchema: event.request.inputSchema,
          ...(event.request.expiresInMs ? {
            expiresAtMs: this.#clock.nowMs() + event.request.expiresInMs,
          } : {}),
          ...(event.request.sensitiveAnswer ? { metadata: { sensitiveAnswer: true } } : {}),
        })),
        nowMs: this.#clock.nowMs(),
      });
      for (const toolCall of committed.toolCalls) {
        await this.#publish({ type: 'tool_call.upserted', sessionId: target.sessionId, toolCall });
      }
      for (const toolRun of committed.toolRuns) {
        await this.#publish({ type: 'tool_run.upserted', sessionId: target.sessionId, toolRun });
      }
      for (const request of committed.requests) {
        await this.#publish({ type: 'user_input.upserted', sessionId: target.sessionId, request });
      }
      await this.#publish({ type: 'task_run.upserted', sessionId: target.sessionId, taskRun: committed.taskRun });
      await this.#publish({ type: 'task.upserted', sessionId: target.sessionId, task: committed.task });
      return committed;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async publishTaskFinish(result: FinishTaskResult): Promise<void> {
    for (const event of taskFinishEvents(result)) await this.#publish(event);
  }

  #messageId(taskId: string, outputId: string): string {
    const key = `${taskId}:${outputId}`;
    let messageId = this.#messageIdsByOutput.get(key);
    if (!messageId) {
      messageId = this.#ids.messageId();
      this.#messageIdsByOutput.set(key, messageId);
    }
    return messageId;
  }

  async #publish(event: AgentRealtimeEvent): Promise<void> {
    if (!this.options.publisher) return;
    try {
      await this.options.publisher.publish(event);
    } catch (error) {
      try { this.options.onPublishError?.(error, event); } catch { /* post-commit only */ }
    }
  }
}

const randomWriterIds: RuntimeEventWriterIds = {
  eventId: () => `event_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  toolCallId: () => `tool_call_${randomUUID()}`,
  artifactId: () => `artifact_${randomUUID()}`,
  userInputRequestId: () => `input_${randomUUID()}`,
};
