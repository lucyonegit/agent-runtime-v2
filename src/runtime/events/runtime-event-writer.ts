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
import {
  checksumToolArguments,
  createToolIdempotencyKey,
} from '../execution/helpers/tool-call-identity.helper.js';

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
  readonly #definitions: Map<string, RuntimeTool>;
  readonly #publisher?: RuntimeEventPublisher;
  readonly #ids: RuntimeEventWriterIds;
  readonly #clock: { nowMs(): number };
  readonly #onPublishError?: (error: unknown, event: AgentRealtimeEvent) => void;
  readonly #requireModelCallAudit: boolean;
  readonly #messageIdsByOutput = new Map<string, string>();

  constructor(options: RuntimeEventWriterOptions) {
    this.#store = options.store;
    this.#workerId = options.workerId;
    this.#definitions = new Map(options.tools.map(tool => [tool.tool.name, tool]));
    this.#publisher = options.publisher;
    this.#ids = options.ids ?? randomWriterIds;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#onPublishError = options.onPublishError;
    this.#requireModelCallAudit = options.requireModelCallAudit ?? false;
  }

  async record(event: LoopEvent, target: AgentLoopTarget): Promise<RuntimeEventRecordResult> {
    if (event.type === LOOP_EVENT_TYPES.ModelOutputDelta) {
      await this.#publish({
        type: 'message.delta',
        eventId: this.#ids.eventId(),
        sessionId: target.sessionId,
        jobId: target.jobId,
        messageId: this.#messageId(target.jobId, event.outputId),
        outputId: event.outputId,
        channel: event.channel,
        delta: event.delta,
      });
      return { type: 'published_delta' };
    }

    if (event.type === LOOP_EVENT_TYPES.ModelOutputRejected) {
      await this.#setModelCallOutputDisposition({
        jobId: target.jobId,
        outputId: event.outputId,
        disposition: 'rejected',
        reason: event.reason,
      });
      await this.#publish({
        type: 'message.discarded',
        eventId: this.#ids.eventId(),
        sessionId: target.sessionId,
        jobId: target.jobId,
        messageId: this.#messageId(target.jobId, event.outputId),
        outputId: event.outputId,
        reason: event.reason,
      });
      return { type: 'discarded_output' };
    }

    if (event.type === LOOP_EVENT_TYPES.ModelOutputCompleted) {
      await this.#setModelCallOutputDisposition({
        jobId: target.jobId,
        outputId: event.outputId,
        disposition: 'accepted',
      });
      if (event.toolCalls.length === 0) return { type: 'final_candidate', event };
      try {
        const committed = await this.#store.commitModelToolCalls({
          sessionId: target.sessionId,
          jobId: target.jobId,
          attemptId: target.attemptId,
          workerId: this.#workerId,
          outputId: event.outputId,
          messageId: this.#messageId(target.jobId, event.outputId),
          content: event.content,
          invocations: event.toolCalls.map(call => {
            const definition = this.#definitions.get(call.name);
            const persistedCall = {
              ...call,
              args: redactToolArguments(call.args, definition?.sensitiveArgumentPaths ?? []),
            };
            return {
              invocationId: this.#ids.toolInvocationId(),
              call: persistedCall,
              argumentsChecksum: checksumToolArguments(call.args),
              sideEffectLevel: definition?.sideEffectLevel ?? 'read_only',
              idempotencyKey: createToolIdempotencyKey(target.jobId, call.id),
            };
          }),
          nowMs: this.#clock.nowMs(),
        });
        await this.#publish({
          type: 'message.upserted',
          sessionId: target.sessionId,
          message: committed.message,
        });
        for (const invocation of committed.invocations) {
          await this.#publish({
            type: 'tool_invocation.upserted',
            sessionId: target.sessionId,
            invocation,
          });
        }
        return { type: 'committed_tool_calls', message: committed.message };
      } catch (error) {
        throw mapStoreError(error);
      }
    }

    if (
      event.type === LOOP_EVENT_TYPES.ToolResultCompleted
      || event.type === LOOP_EVENT_TYPES.ToolResultFailed
    ) {
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
        const committed = await this.#store.commitToolResult({
          sessionId: target.sessionId,
          jobId: target.jobId,
          attemptId: target.attemptId,
          workerId: this.#workerId,
          toolCallId: event.toolCallId,
          messageId: this.#ids.messageId(),
          outcome,
          nowMs: this.#clock.nowMs(),
        });
        await this.#publish({
          type: 'message.upserted',
          sessionId: target.sessionId,
          message: committed.message,
        });
        await this.#publish({
          type: 'tool_invocation.upserted',
          sessionId: target.sessionId,
          invocation: committed.invocation,
        });
        for (const artifact of committed.artifacts) {
          await this.#publish({
            type: 'artifact.upserted',
            sessionId: target.sessionId,
            artifact,
          });
        }
        return { type: 'committed_tool_result', message: committed.message };
      } catch (error) {
        throw mapStoreError(error);
      }
    }

    return { type: 'input_required', event };
  }

  async completeFinal(
    event: Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted }>,
    target: AgentLoopTarget
  ): Promise<{ job: AgentJob; message: AgentMessage }> {
    if (event.toolCalls.length > 0) {
      throw new TypeError('A tool-call model output cannot complete a Job as final.');
    }
    try {
      const committed = await this.#store.completeJobWithFinalMessage({
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
      const committed = await this.#store.createInputRequestsAndMarkWaiting({
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

  async #setModelCallOutputDisposition(
    input: Parameters<AgentStore['setModelCallOutputDisposition']>[0]
  ): Promise<void> {
    try {
      await this.#store.setModelCallOutputDisposition(input);
    } catch (error) {
      if (this.#requireModelCallAudit) throw error;
    }
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

export function redactToolArguments(
  arguments_: Record<string, unknown>,
  sensitivePaths: string[]
): Record<string, unknown> {
  if (sensitivePaths.length === 0) return arguments_;
  const copy = structuredClone(arguments_);
  for (const path of sensitivePaths) {
    const segments = path.startsWith('/')
      ? path.slice(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
      : path.split('.');
    let owner: unknown = copy;
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (!owner || typeof owner !== 'object') break;
      owner = (owner as Record<string, unknown>)[segments[index]!];
    }
    const key = segments.at(-1);
    if (key && owner && typeof owner === 'object' && key in owner) {
      (owner as Record<string, unknown>)[key] = '[REDACTED]';
    }
  }
  return copy;
}

const randomWriterIds: RuntimeEventWriterIds = {
  eventId: () => `event_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  toolInvocationId: () => `invocation_${randomUUID()}`,
  artifactId: () => `artifact_${randomUUID()}`,
  userInputRequestId: () => `input_${randomUUID()}`,
};
