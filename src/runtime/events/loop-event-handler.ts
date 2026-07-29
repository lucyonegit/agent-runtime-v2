import { randomUUID } from 'node:crypto';
import type {
  AgentMessage,
  AgentRealtimeEvent,
  AgentTask,
  AgentUserInputRequest,
} from '../../domain/index.js';
import type { AgentStore, FinishTaskResult } from '../../storage/agent-store.js';
import { mapStoreError } from '../errors/runtime-error.js';
import type { RuntimeTool } from '../execution/tool-executor.js';
import { checksumToolArguments, createToolIdempotencyKey } from '../execution/helpers/tool-call-identity.helper.js';
import type { AgentLoopTarget } from '../loop/agent-loop.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../loop/loop-events.js';
import { redactToolArguments } from './helpers/event-payload.helper.js';
import { taskFinishEvents } from './helpers/task-finish-events.js';
import type { RuntimeEventPublisher } from './runtime-event-publisher.js';
import { createSideEffectConfirmationRequest } from '../hitl/side-effect-confirmation.js';

export { redactToolArguments } from './helpers/event-payload.helper.js';

export interface LoopEventHandlerIds {
  eventId(): string;
  messageId(): string;
  toolCallId(): string;
  artifactId?(): string;
  userInputRequestId(): string;
}

export interface LoopEventHandlerOptions {
  store: AgentStore;
  ownerId: string;
  tools: RuntimeTool[];
  publisher?: RuntimeEventPublisher;
  ids?: LoopEventHandlerIds;
  clock?: { nowMs(): number };
  requireModelCallAudit?: boolean;
  onPublishError?: (error: unknown, event: AgentRealtimeEvent) => void;
}

/** The only LoopEvent feedback that changes execution control flow. */
export interface LoopEventFeedback {
  waitingForUser: {
    task: AgentTask;
    requests: AgentUserInputRequest[];
  };
}

/** Commits durable LoopEvent state when needed, then publishes its realtime projection. */
export class LoopEventHandler {
  readonly #ids: LoopEventHandlerIds;
  readonly #clock: { nowMs(): number };
  readonly #definitions: Map<string, RuntimeTool>;
  readonly #messageIdsByOutput = new Map<string, string>();

  constructor(private readonly options: LoopEventHandlerOptions) {
    this.#ids = options.ids ?? randomHandlerIds;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#definitions = new Map(options.tools.map(tool => [tool.tool.name, tool]));
  }

  async handle(event: LoopEvent, target: AgentLoopTarget): Promise<LoopEventFeedback | undefined> {
    if (event.type === LOOP_EVENT_TYPES.ModelOutputDelta) {
      await this.#publish({
        type: 'message.delta',
        eventId: this.#ids.eventId(),
        sessionId: target.sessionId,
        taskId: target.taskId,
        messageId: this.#messageId(target.taskId, event.outputId),
        outputId: event.outputId,
        channel: event.channel,
        delta: event.delta,
      });
      return undefined;
    }
    if (event.type === LOOP_EVENT_TYPES.ModelOutputRejected) {
      await this.#setOutputDisposition(target.taskId, event.outputId, 'rejected', event.reason);
      await this.#publish({
        type: 'message.discarded',
        eventId: this.#ids.eventId(),
        sessionId: target.sessionId,
        taskId: target.taskId,
        messageId: this.#messageId(target.taskId, event.outputId),
        outputId: event.outputId,
        reason: event.reason,
      });
      return undefined;
    }
    if (event.type === LOOP_EVENT_TYPES.ModelOutputCompleted) {
      await this.#handleModelOutput(event, target);
      return undefined;
    }
    if (event.type === LOOP_EVENT_TYPES.ToolResultCompleted
      || event.type === LOOP_EVENT_TYPES.ToolResultFailed) {
      return this.#handleToolResult(event, target);
    }
    return undefined;
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
      await this.#publish({
        type: 'message.upserted',
        sessionId: target.sessionId,
        message: committed.message,
      });
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
          kind: 'tool_input',
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
      await this.#publish({
        type: 'task_run.upserted',
        sessionId: target.sessionId,
        taskRun: committed.taskRun,
      });
      await this.#publish({
        type: 'task.upserted',
        sessionId: target.sessionId,
        task: committed.task,
      });
      return committed;
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async publishTaskFinish(result: FinishTaskResult): Promise<void> {
    for (const event of taskFinishEvents(result)) await this.#publish(event);
  }

  async #handleModelOutput(
    event: Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted }>,
    target: AgentLoopTarget
  ): Promise<void> {
    await this.#setOutputDisposition(target.taskId, event.outputId, 'accepted');
    if (event.toolCalls.length === 0) return;
    try {
      const contextScope = event.toolCalls.every(call => (
        this.#definitions.get(call.name)?.contextScope === 'task'
      )) ? 'task' : 'conversation';
      const committed = await this.options.store.execution.saveToolCalls({
        sessionId: target.sessionId,
        taskId: target.taskId,
        taskRunId: target.taskRunId,
        ownerId: this.options.ownerId,
        outputId: event.outputId,
        messageId: this.#messageId(target.taskId, event.outputId),
        content: event.content,
        contextScope,
        toolCalls: event.toolCalls.map(call => {
          const definition = this.#definitions.get(call.name);
          return {
            id: this.#ids.toolCallId(),
            call: {
              ...call,
              args: redactToolArguments(call.args, definition?.sensitiveArgumentPaths ?? []),
            },
            argumentsChecksum: checksumToolArguments(call.args),
            sideEffectLevel: definition?.sideEffectLevel ?? 'read_only',
            idempotencyKey: createToolIdempotencyKey(target.taskId, call.id),
          };
        }),
        nowMs: this.#clock.nowMs(),
      });
      await this.#publish({
        type: 'message.upserted',
        sessionId: target.sessionId,
        message: committed.message,
      });
      for (const toolCall of committed.toolCalls) {
        await this.#publish({ type: 'tool_call.upserted', sessionId: target.sessionId, toolCall });
      }
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #handleToolResult(
    event: Extract<LoopEvent, {
      type: typeof LOOP_EVENT_TYPES.ToolResultCompleted | typeof LOOP_EVENT_TYPES.ToolResultFailed;
    }>,
    target: AgentLoopTarget
  ): Promise<LoopEventFeedback | undefined> {
    try {
      const outcome = event.type === LOOP_EVENT_TYPES.ToolResultCompleted
        ? {
            status: 'completed' as const,
            content: event.content,
            result: event.result,
            artifacts: event.artifacts?.map(artifact => ({
              ...artifact,
              id: this.#ids.artifactId?.() ?? `artifact_${randomUUID()}`,
            })),
            durationMs: event.durationMs,
          }
        : {
            status: 'failed' as const,
            executionStarted: event.executionStarted,
            code: event.code,
            message: event.message,
            details: event.details,
            durationMs: event.durationMs,
          };
      const committed = await this.options.store.execution.completeToolCall({
        sessionId: target.sessionId,
        taskId: target.taskId,
        taskRunId: target.taskRunId,
        ownerId: this.options.ownerId,
        modelToolCallId: event.modelToolCallId,
        messageId: this.#ids.messageId(),
        confirmationRequest: createSideEffectConfirmationRequest({
          requestId: this.#ids.userInputRequestId(),
          toolName: event.toolName,
          reason: 'runtime_failure',
        }),
        outcome,
        nowMs: this.#clock.nowMs(),
      });
      if (committed.message) {
        await this.#publish({
          type: 'message.upserted',
          sessionId: target.sessionId,
          message: committed.message,
        });
      }
      await this.#publish({
        type: 'tool_call.upserted',
        sessionId: target.sessionId,
        toolCall: committed.toolCall,
      });
      await this.#publish({
        type: 'tool_run.upserted',
        sessionId: target.sessionId,
        toolRun: committed.toolRun,
      });
      for (const artifact of committed.artifacts) {
        await this.#publish({ type: 'artifact.upserted', sessionId: target.sessionId, artifact });
      }
      if (!committed.confirmationRequired) return undefined;
      await this.#publish({
        type: 'user_input.upserted',
        sessionId: target.sessionId,
        request: committed.confirmationRequired.request,
      });
      await this.#publish({
        type: 'task_run.upserted',
        sessionId: target.sessionId,
        taskRun: committed.confirmationRequired.taskRun,
      });
      await this.#publish({
        type: 'task.upserted',
        sessionId: target.sessionId,
        task: committed.confirmationRequired.task,
      });
      return {
        waitingForUser: {
          task: committed.confirmationRequired.task,
          requests: [committed.confirmationRequired.request],
        },
      };
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #setOutputDisposition(
    taskId: string,
    outputId: string,
    disposition: 'accepted' | 'rejected',
    reason?: string
  ): Promise<void> {
    try {
      await this.options.store.models.setCallOutputDisposition({
        taskId, outputId, disposition, ...(reason ? { reason } : {}),
      });
    } catch (error) {
      if (this.options.requireModelCallAudit) throw error;
    }
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

const randomHandlerIds: LoopEventHandlerIds = {
  eventId: () => `event_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  toolCallId: () => `tool_call_${randomUUID()}`,
  artifactId: () => `artifact_${randomUUID()}`,
  userInputRequestId: () => `input_${randomUUID()}`,
};
