import { randomUUID } from 'node:crypto';
import type { AgentRealtimeEvent } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import type { AgentLoopTarget } from '../../loop/agent-loop.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../../loop/loop-events.js';
import type { RuntimeTool } from '../../execution/tool-executor.js';
import {
  checksumToolArguments,
  createToolIdempotencyKey,
} from '../../execution/helpers/tool-call-identity.helper.js';
import { mapStoreError } from '../../errors/runtime-error.js';
import { redactToolArguments } from '../helpers/event-payload.helper.js';
import type {
  RuntimeEventRecordResult,
  RuntimeEventWriterIds,
} from '../runtime-event-writer.js';

interface LoopEventHandlerOptions {
  store: AgentStore;
  workerId: string;
  tools: RuntimeTool[];
  ids: RuntimeEventWriterIds;
  clock: { nowMs(): number };
  requireModelCallAudit: boolean;
  messageId(jobId: string, outputId: string): string;
  publish(event: AgentRealtimeEvent): Promise<void>;
}

/** Persists and publishes each concrete AgentLoop event. */
export class LoopEventHandler {
  readonly #options: LoopEventHandlerOptions;
  readonly #definitions: Map<string, RuntimeTool>;

  constructor(options: LoopEventHandlerOptions) {
    this.#options = options;
    this.#definitions = new Map(options.tools.map(tool => [tool.tool.name, tool]));
  }

  async record(event: LoopEvent, target: AgentLoopTarget): Promise<RuntimeEventRecordResult> {
    if (event.type === LOOP_EVENT_TYPES.ModelOutputDelta) {
      await this.#options.publish({
        type: 'message.delta',
        eventId: this.#options.ids.eventId(),
        sessionId: target.sessionId,
        jobId: target.jobId,
        messageId: this.#options.messageId(target.jobId, event.outputId),
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
      await this.#options.publish({
        type: 'message.discarded',
        eventId: this.#options.ids.eventId(),
        sessionId: target.sessionId,
        jobId: target.jobId,
        messageId: this.#options.messageId(target.jobId, event.outputId),
        outputId: event.outputId,
        reason: event.reason,
      });
      return { type: 'discarded_output' };
    }

    if (event.type === LOOP_EVENT_TYPES.ModelOutputCompleted) {
      return this.#recordModelOutput(event, target);
    }

    if (
      event.type === LOOP_EVENT_TYPES.ToolResultCompleted
      || event.type === LOOP_EVENT_TYPES.ToolResultFailed
    ) {
      return this.#recordToolResult(event, target);
    }

    return { type: 'input_required', event };
  }

  async #recordModelOutput(
    event: Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted }>,
    target: AgentLoopTarget
  ): Promise<RuntimeEventRecordResult> {
    await this.#setModelCallOutputDisposition({
      jobId: target.jobId,
      outputId: event.outputId,
      disposition: 'accepted',
    });
    if (event.toolCalls.length === 0) return { type: 'final_candidate', event };
    try {
      const committed = await this.#options.store.execution.commitModelToolCalls({
        sessionId: target.sessionId,
        jobId: target.jobId,
        attemptId: target.attemptId,
        workerId: this.#options.workerId,
        outputId: event.outputId,
        messageId: this.#options.messageId(target.jobId, event.outputId),
        content: event.content,
        invocations: event.toolCalls.map(call => {
          const definition = this.#definitions.get(call.name);
          const persistedCall = {
            ...call,
            args: redactToolArguments(call.args, definition?.sensitiveArgumentPaths ?? []),
          };
          return {
            invocationId: this.#options.ids.toolInvocationId(),
            call: persistedCall,
            argumentsChecksum: checksumToolArguments(call.args),
            sideEffectLevel: definition?.sideEffectLevel ?? 'read_only',
            idempotencyKey: createToolIdempotencyKey(target.jobId, call.id),
          };
        }),
        nowMs: this.#options.clock.nowMs(),
      });
      await this.#options.publish({
        type: 'message.upserted',
        sessionId: target.sessionId,
        message: committed.message,
      });
      for (const invocation of committed.invocations) {
        await this.#options.publish({
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

  async #recordToolResult(
    event: Extract<LoopEvent, {
      type: typeof LOOP_EVENT_TYPES.ToolResultCompleted
        | typeof LOOP_EVENT_TYPES.ToolResultFailed;
    }>,
    target: AgentLoopTarget
  ): Promise<RuntimeEventRecordResult> {
    try {
      const outcome = event.type === LOOP_EVENT_TYPES.ToolResultCompleted
        ? {
            status: 'completed' as const,
            content: event.content,
            result: event.result,
            artifacts: event.artifacts?.map(artifact => ({
              ...artifact,
              id: this.#options.ids.artifactId?.() ?? `artifact_${randomUUID()}`,
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
      const committed = await this.#options.store.execution.commitToolResult({
        sessionId: target.sessionId,
        jobId: target.jobId,
        attemptId: target.attemptId,
        workerId: this.#options.workerId,
        toolCallId: event.toolCallId,
        messageId: this.#options.ids.messageId(),
        outcome,
        nowMs: this.#options.clock.nowMs(),
      });
      await this.#options.publish({
        type: 'message.upserted',
        sessionId: target.sessionId,
        message: committed.message,
      });
      await this.#options.publish({
        type: 'tool_invocation.upserted',
        sessionId: target.sessionId,
        invocation: committed.invocation,
      });
      for (const artifact of committed.artifacts) {
        await this.#options.publish({
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

  async #setModelCallOutputDisposition(
    input: Parameters<AgentStore['models']['setCallOutputDisposition']>[0]
  ): Promise<void> {
    try {
      await this.#options.store.models.setCallOutputDisposition(input);
    } catch (error) {
      if (this.#options.requireModelCallAudit) throw error;
    }
  }
}
