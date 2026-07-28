import { randomUUID } from 'node:crypto';
import type { AgentRealtimeEvent } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import type { AgentLoopTarget } from '../../loop/agent-loop.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../../loop/loop-events.js';
import type { RuntimeTool } from '../../execution/tool-executor.js';
import { checksumToolArguments, createToolIdempotencyKey } from '../../execution/helpers/tool-call-identity.helper.js';
import { mapStoreError } from '../../errors/runtime-error.js';
import { redactToolArguments } from '../helpers/event-payload.helper.js';
import type { RuntimeEventRecordResult, RuntimeEventWriterIds } from '../runtime-event-writer.js';

interface LoopEventHandlerOptions {
  store: AgentStore;
  ownerId: string;
  tools: RuntimeTool[];
  ids: RuntimeEventWriterIds;
  clock: { nowMs(): number };
  requireModelCallAudit: boolean;
  messageId(taskId: string, outputId: string): string;
  publish(event: AgentRealtimeEvent): Promise<void>;
}

/** Persists a stable LoopEvent before publishing its realtime projection. */
export class LoopEventHandler {
  readonly #definitions: Map<string, RuntimeTool>;

  constructor(private readonly options: LoopEventHandlerOptions) {
    this.#definitions = new Map(options.tools.map(tool => [tool.tool.name, tool]));
  }

  async record(event: LoopEvent, target: AgentLoopTarget): Promise<RuntimeEventRecordResult> {
    if (event.type === LOOP_EVENT_TYPES.ModelOutputDelta) {
      await this.options.publish({
        type: 'message.delta',
        eventId: this.options.ids.eventId(),
        sessionId: target.sessionId,
        taskId: target.taskId,
        messageId: this.options.messageId(target.taskId, event.outputId),
        outputId: event.outputId,
        channel: event.channel,
        delta: event.delta,
      });
      return { type: 'published_delta' };
    }
    if (event.type === LOOP_EVENT_TYPES.ModelOutputRejected) {
      await this.#setOutputDisposition(target.taskId, event.outputId, 'rejected', event.reason);
      await this.options.publish({
        type: 'message.discarded',
        eventId: this.options.ids.eventId(),
        sessionId: target.sessionId,
        taskId: target.taskId,
        messageId: this.options.messageId(target.taskId, event.outputId),
        outputId: event.outputId,
        reason: event.reason,
      });
      return { type: 'discarded_output' };
    }
    if (event.type === LOOP_EVENT_TYPES.ModelOutputCompleted) {
      return this.#recordModelOutput(event, target);
    }
    if (event.type === LOOP_EVENT_TYPES.ToolResultCompleted
      || event.type === LOOP_EVENT_TYPES.ToolResultFailed) {
      return this.#recordToolResult(event, target);
    }
    return { type: 'input_required', event };
  }

  async #recordModelOutput(
    event: Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted }>,
    target: AgentLoopTarget
  ): Promise<RuntimeEventRecordResult> {
    await this.#setOutputDisposition(target.taskId, event.outputId, 'accepted');
    if (event.toolCalls.length === 0) return { type: 'final_candidate', event };
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
        messageId: this.options.messageId(target.taskId, event.outputId),
        content: event.content,
        contextScope,
        toolCalls: event.toolCalls.map(call => {
          const definition = this.#definitions.get(call.name);
          return {
            id: this.options.ids.toolCallId(),
            call: {
              ...call,
              args: redactToolArguments(call.args, definition?.sensitiveArgumentPaths ?? []),
            },
            argumentsChecksum: checksumToolArguments(call.args),
            sideEffectLevel: definition?.sideEffectLevel ?? 'read_only',
            idempotencyKey: createToolIdempotencyKey(target.taskId, call.id),
          };
        }),
        nowMs: this.options.clock.nowMs(),
      });
      await this.options.publish({
        type: 'message.upserted', sessionId: target.sessionId, message: committed.message,
      });
      for (const toolCall of committed.toolCalls) {
        await this.options.publish({ type: 'tool_call.upserted', sessionId: target.sessionId, toolCall });
      }
      return { type: 'committed_tool_calls', message: committed.message };
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async #recordToolResult(
    event: Extract<LoopEvent, {
      type: typeof LOOP_EVENT_TYPES.ToolResultCompleted | typeof LOOP_EVENT_TYPES.ToolResultFailed;
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
              id: this.options.ids.artifactId?.() ?? `artifact_${randomUUID()}`,
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
        messageId: this.options.ids.messageId(),
        outcome,
        nowMs: this.options.clock.nowMs(),
      });
      await this.options.publish({
        type: 'message.upserted', sessionId: target.sessionId, message: committed.message,
      });
      await this.options.publish({
        type: 'tool_call.upserted', sessionId: target.sessionId, toolCall: committed.toolCall,
      });
      await this.options.publish({
        type: 'tool_run.upserted', sessionId: target.sessionId, toolRun: committed.toolRun,
      });
      for (const artifact of committed.artifacts) {
        await this.options.publish({ type: 'artifact.upserted', sessionId: target.sessionId, artifact });
      }
      return { type: 'committed_tool_result', message: committed.message };
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
}
