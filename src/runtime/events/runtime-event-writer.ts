import { randomUUID } from 'node:crypto';
import type { AgentJob, AgentMessage, AgentRealtimeEvent } from '../../domain/index.js';
import {
  LOOP_EVENT_TYPES,
  type LoopEvent,
} from '../loop/loop-events.js';
import type { RuntimeTool } from '../execution/tool-executor.js';
import type { AgentLoopTarget } from '../loop/agent-loop.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { mapStoreError } from '../errors/runtime-error.js';
import { LoopEventHandler } from './handlers/loop-event.handler.js';

export { redactToolArguments } from './helpers/event-payload.helper.js';

export interface RuntimeEventPublisher {
  publish(event: AgentRealtimeEvent): void | Promise<void>;
}

export interface RuntimeEventWriterIds {
  eventId(): string;
  messageId(): string;
  toolInvocationId(): string;
  artifactId?(): string;
  userInputRequestId(): string;
}

export interface RuntimeEventWriterOptions {
  store: AgentStore;
  workerId: string;
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
  | { type: 'final_candidate'; event: Extract<LoopEvent, {
      type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted;
    }> }
  | { type: 'input_required'; event: Extract<LoopEvent, {
      type: typeof LOOP_EVENT_TYPES.ToolInputRequired;
    }> };

export class RuntimeEventWriter {
  readonly #store: AgentStore;
  readonly #workerId: string;
  readonly #publisher?: RuntimeEventPublisher;
  readonly #ids: RuntimeEventWriterIds;
  readonly #clock: { nowMs(): number };
  readonly #onPublishError?: (error: unknown, event: AgentRealtimeEvent) => void;
  readonly #messageIdsByOutput = new Map<string, string>();
  readonly #loopEventHandler: LoopEventHandler;

  constructor(options: RuntimeEventWriterOptions) {
    this.#store = options.store;
    this.#workerId = options.workerId;
    this.#publisher = options.publisher;
    this.#ids = options.ids ?? randomWriterIds;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#onPublishError = options.onPublishError;
    this.#loopEventHandler = new LoopEventHandler({
      store: this.#store,
      workerId: this.#workerId,
      tools: options.tools,
      ids: this.#ids,
      clock: this.#clock,
      requireModelCallAudit: options.requireModelCallAudit ?? false,
      messageId: (jobId, outputId) => this.#messageId(jobId, outputId),
      publish: event => this.#publish(event),
    });
  }

  async record(event: LoopEvent, target: AgentLoopTarget): Promise<RuntimeEventRecordResult> {
    return this.#loopEventHandler.record(event, target);
  }

  async completeFinal(
    event: Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted }>,
    target: AgentLoopTarget
  ): Promise<{ job: AgentJob; message: AgentMessage }> {
    if (event.toolCalls.length > 0) {
      throw new TypeError('A tool-call model output cannot complete a Job as final.');
    }
    try {
      const committed = await this.#store.execution.completeWithFinalMessage({
        sessionId: target.sessionId,
        jobId: target.jobId,
        attemptId: target.attemptId,
        workerId: this.#workerId,
        outputId: event.outputId,
        messageId: this.#messageId(target.jobId, event.outputId),
        content: event.content,
        nowMs: this.#clock.nowMs(),
      });
      await this.#publish({
        type: 'message.upserted',
        sessionId: target.sessionId,
        message: committed.message,
      });
      await this.#publish({
        type: 'job.upserted',
        sessionId: target.sessionId,
        job: committed.job,
      });
      return committed;
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
      const committed = await this.#store.execution.waitForUserInput({
        sessionId: target.sessionId,
        jobId: target.jobId,
        attemptId: target.attemptId,
        workerId: this.#workerId,
        requests: events.map(event => ({
          requestId: this.#ids.userInputRequestId(),
          toolCallId: event.toolCallId,
          source: event.request.source,
          answerMode: event.request.answerMode,
          title: event.request.title,
          prompt: event.request.prompt,
          inputSchema: event.request.inputSchema,
          ...(event.request.sensitiveAnswer ? { metadata: { sensitiveAnswer: true } } : {}),
        })),
        nowMs: this.#clock.nowMs(),
      });
      for (const invocation of committed.invocations) {
        await this.#publish({
          type: 'tool_invocation.upserted',
          sessionId: target.sessionId,
          invocation,
        });
      }
      for (const request of committed.requests) {
        await this.#publish({
          type: 'user_input.upserted',
          sessionId: target.sessionId,
          request,
        });
      }
      await this.#publish({
        type: 'job.upserted',
        sessionId: target.sessionId,
        job: committed.job,
      });
      return committed;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  #messageId(jobId: string, outputId: string): string {
    const key = `${jobId}:${outputId}`;
    let messageId = this.#messageIdsByOutput.get(key);
    if (!messageId) {
      messageId = this.#ids.messageId();
      this.#messageIdsByOutput.set(key, messageId);
    }
    return messageId;
  }

  async #publish(event: AgentRealtimeEvent): Promise<void> {
    if (!this.#publisher) return;
    try {
      await this.#publisher.publish(event);
    } catch (error) {
      try {
        this.#onPublishError?.(error, event);
      } catch {
        // Publishing is post-commit and must never change the durable outcome.
      }
    }
  }
}

const randomWriterIds: RuntimeEventWriterIds = {
  eventId: () => `event_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  toolInvocationId: () => `invocation_${randomUUID()}`,
  artifactId: () => `artifact_${randomUUID()}`,
  userInputRequestId: () => `input_${randomUUID()}`,
};
