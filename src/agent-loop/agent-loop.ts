import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
  type UsageMetadata,
} from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentToolCall } from '../domain/index.js';
import {
  LOOP_EVENT_TYPES,
  type LoopEvent,
  type LoopMessageChannel,
  type ToolUserInputRequest,
} from './loop-events.js';
import type { LoopResult } from './loop-result.js';
import {
  readLangChainModelTurn,
  type LangChainChatRunnable,
  type LangChainToolCallError,
} from './langchain-model.js';

export interface AgentLoopTarget {
  sessionId: string;
  jobId: string;
  stepRunId?: string;
  attemptId: string;
}

export interface AgentLoopLimits {
  maxIterations: number;
  maxToolCalls: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface AgentLoopInput {
  messages: BaseMessage[];
  target: AgentLoopTarget;
  tools: StructuredToolInterface[];
  toolExecutor: ToolExecutorPort;
  outputIdFactory: () => string;
  limits: AgentLoopLimits;
  deltaChannel?: LoopMessageChannel;
}

export type ToolExecutionResult =
  | { type: 'completed'; content: string; result?: unknown }
  | { type: 'failed'; code: string; message: string; details?: unknown }
  | { type: 'requires_user_input'; request: ToolUserInputRequest };

export interface ToolExecutionRequest {
  call: AgentToolCall;
  definition?: StructuredToolInterface;
  target: AgentLoopTarget;
  signal?: AbortSignal;
}

export interface ToolExecutorPort {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}

export class FatalToolExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'FatalToolExecutionError';
    this.code = code;
  }
}

export interface AgentLoopOptions {
  model: LangChainChatRunnable;
  streaming?: boolean;
  clock?: { nowMs(): number };
}

interface ModelTurn {
  outputId: string;
  content: string;
  toolCalls: AgentToolCall[];
  assemblyErrors: LangChainToolCallError[];
  usage?: UsageMetadata;
}

type ToolOutcome =
  | {
      type: 'event';
      call: AgentToolCall;
      event: Extract<LoopEvent, {
        type:
          | typeof LOOP_EVENT_TYPES.ToolResultCompleted
          | typeof LOOP_EVENT_TYPES.ToolResultFailed;
      }>;
      toolMessageContent: string;
    }
  | {
      type: 'input';
      call: AgentToolCall;
      event: Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ToolInputRequired }>;
    };

export class AgentLoop {
  readonly #model: LangChainChatRunnable;
  readonly #streaming: boolean;
  readonly #clock: { nowMs(): number };

  constructor(options: AgentLoopOptions) {
    this.#model = options.model;
    this.#streaming = options.streaming ?? true;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async *run(input: AgentLoopInput): AsyncGenerator<LoopEvent, LoopResult> {
    assertLimits(input.limits);
    const messages = [...input.messages];
    const definitions = new Map(input.tools.map(tool => [tool.name, tool]));
    let executedToolCalls = 0;

    for (let iteration = 0; iteration < input.limits.maxIterations; iteration += 1) {
      const preflight = this.#terminalPreflight(input.limits);
      if (preflight) return preflight;

      let turn: ModelTurn;
      try {
        turn = this.#streaming
          ? yield* this.#readStreamingTurn(input, messages)
          : await this.#readModelTurn(input, messages);
      } catch (error) {
        return this.#modelFailure(error, input.limits.signal);
      }

      if (turn.toolCalls.length === 0) {
        if (!turn.content.trim()) {
          return {
            type: 'failed',
            code: 'empty_model_output',
            message: 'Model returned neither text nor tool calls.',
          };
        }
        yield {
          type: LOOP_EVENT_TYPES.ModelOutputCompleted,
          outputId: turn.outputId,
          content: turn.content,
          toolCalls: [],
          usage: turn.usage,
        };
        return { type: 'completed', outputId: turn.outputId, content: turn.content };
      }

      // The consumer must durably commit this event before requesting the next
      // generator item. No tool execution happens before this yield resumes.
      yield {
        type: LOOP_EVENT_TYPES.ModelOutputCompleted,
        outputId: turn.outputId,
        content: turn.content,
        toolCalls: turn.toolCalls,
        usage: turn.usage,
      };
      appendAssistantToolCalls(messages, turn.content, turn.toolCalls);

      if (executedToolCalls + turn.toolCalls.length > input.limits.maxToolCalls) {
        return {
          type: 'failed',
          code: 'max_tool_calls',
          message: `Tool-call limit ${input.limits.maxToolCalls} would be exceeded.`,
          details: {
            executedToolCalls,
            requestedToolCalls: turn.toolCalls.length,
          },
        };
      }
      executedToolCalls += turn.toolCalls.length;

      const conflictingChunk = turn.assemblyErrors.find(error => error.code === 'model_error');
      if (conflictingChunk) {
        yield assemblyFailureEvent(conflictingChunk);
        appendToolMessage(messages, conflictingChunk.call.id, conflictingChunk.message);
        return {
          type: 'failed',
          code: 'model_error',
          message: conflictingChunk.message,
          details: conflictingChunk.details,
        };
      }

      const assemblyErrorsByCall = new Map(
        turn.assemblyErrors.map(error => [error.call.id, error])
      );
      const inputRequests: Extract<ToolOutcome, { type: 'input' }>[] = [];
      for (const call of turn.toolCalls) {
        const assemblyError = assemblyErrorsByCall.get(call.id);
        if (assemblyError) {
          yield assemblyFailureEvent(assemblyError);
          appendToolMessage(messages, call.id, assemblyError.message);
          continue;
        }

        const beforeTool = this.#terminalPreflight(input.limits);
        if (beforeTool) return beforeTool;
        const outcome = await this.#executeTool(
          input,
          call,
          definitions.get(call.name)
        );
        if (outcome.type === 'input') {
          inputRequests.push(outcome);
          continue;
        }
        // Each stable tool result is durably recorded by the consumer before
        // the loop is resumed to execute the next sibling tool call.
        yield outcome.event;
        appendToolMessage(messages, outcome.call.id, outcome.toolMessageContent);
      }
      for (const outcome of inputRequests) yield outcome.event;
      if (inputRequests.length > 0) {
        return {
          type: 'waiting_user_input',
          toolCallIds: inputRequests.map(outcome => outcome.call.id),
        };
      }
    }

    return {
      type: 'failed',
      code: 'max_iterations',
      message: `Agent loop reached its ${input.limits.maxIterations}-iteration limit.`,
    };
  }

  async #readModelTurn(input: AgentLoopInput, messages: BaseMessage[]): Promise<ModelTurn> {
    const outputId = input.outputIdFactory();
    const response = await this.#model.invoke(messages, { signal: input.limits.signal });
    return modelTurn(response, outputId);
  }

  async *#readStreamingTurn(
    input: AgentLoopInput,
    messages: BaseMessage[]
  ): AsyncGenerator<LoopEvent, ModelTurn> {
    const outputId = input.outputIdFactory();
    let content = '';
    let combined: AIMessageChunk | undefined;
    const stream = await this.#model.stream(messages, { signal: input.limits.signal });
    for await (const chunk of stream) {
      const cancelled = this.#terminalPreflight(input.limits);
      if (cancelled) throw new LoopTerminatedError(cancelled);
      combined = combined ? combined.concat(chunk) : chunk;
      const delta = chunk.text;
      if (delta) {
        content += delta;
        yield {
          type: LOOP_EVENT_TYPES.ModelOutputDelta,
          outputId,
          channel: input.deltaChannel ?? 'normal',
          delta,
        };
      }
    }
    const turn = readLangChainModelTurn(combined ?? new AIMessageChunk(''), outputId);
    return {
      outputId,
      content,
      toolCalls: turn.toolCalls,
      assemblyErrors: turn.errors,
      usage: turn.usage,
    };
  }

  async #executeTool(
    input: AgentLoopInput,
    call: AgentToolCall,
    definition: StructuredToolInterface | undefined
  ): Promise<ToolOutcome> {
    const startedAtMs = this.#clock.nowMs();
    let result: ToolExecutionResult;
    try {
      result = await input.toolExecutor.execute({
        call,
        definition,
        target: input.target,
        signal: input.limits.signal,
      });
    } catch (error) {
      if (error instanceof FatalToolExecutionError) throw error;
      const message = error instanceof Error ? error.message : 'Tool execution failed.';
      result = {
        type: 'failed',
        code: 'tool_failed',
        message,
      };
    }
    const durationMs = Math.max(0, this.#clock.nowMs() - startedAtMs);

    if (result.type === 'requires_user_input') {
      return {
        type: 'input',
        call,
        event: {
          type: LOOP_EVENT_TYPES.ToolInputRequired,
          toolCallId: call.id,
          toolName: call.name,
          request: result.request,
        },
      };
    }
    if (result.type === 'failed') {
      return {
        type: 'event',
        call,
        event: {
          type: LOOP_EVENT_TYPES.ToolResultFailed,
          toolCallId: call.id,
          toolName: call.name,
          code: result.code,
          message: result.message,
          details: result.details,
          durationMs,
        },
        toolMessageContent: result.message,
      };
    }
    return {
      type: 'event',
      call,
      event: {
        type: LOOP_EVENT_TYPES.ToolResultCompleted,
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        result: result.result,
        durationMs,
      },
      toolMessageContent: result.content,
    };
  }

  #terminalPreflight(limits: AgentLoopLimits): LoopResult | undefined {
    if (limits.signal?.aborted) return { type: 'cancelled' };
    if (limits.deadlineMs !== undefined && this.#clock.nowMs() >= limits.deadlineMs) {
      return {
        type: 'failed',
        code: 'deadline_exceeded',
        message: 'Agent loop execution deadline was exceeded.',
      };
    }
    return undefined;
  }

  #modelFailure(error: unknown, signal: AbortSignal | undefined): LoopResult {
    if (error instanceof LoopTerminatedError) return error.result;
    if (signal?.aborted || isAbortError(error)) return { type: 'cancelled' };
    return {
      type: 'failed',
      code: isContextOverflowError(error) ? 'context_overflow' : 'model_error',
      message: error instanceof Error ? error.message : 'Model call failed.',
    };
  }
}

class LoopTerminatedError extends Error {
  readonly result: LoopResult;

  constructor(result: LoopResult) {
    super('Agent loop terminated while reading the model stream.');
    this.result = result;
  }
}

function modelTurn(response: AIMessageChunk, outputId: string): ModelTurn {
  const turn = readLangChainModelTurn(response, outputId);
  return {
    outputId,
    content: turn.content,
    toolCalls: turn.toolCalls,
    assemblyErrors: turn.errors,
    usage: turn.usage,
  };
}

function assemblyFailureEvent(
  error: LangChainToolCallError
): Extract<LoopEvent, { type: typeof LOOP_EVENT_TYPES.ToolResultFailed }> {
  return {
    type: LOOP_EVENT_TYPES.ToolResultFailed,
    toolCallId: error.call.id,
    toolName: error.call.name,
    code: error.code,
    message: error.message,
    details: error.details,
    durationMs: 0,
  };
}

function appendAssistantToolCalls(
  messages: BaseMessage[],
  content: string,
  toolCalls: AgentToolCall[]
): void {
  messages.push(new AIMessage({
    content,
    tool_calls: toolCalls.map(call => ({ ...call, type: 'tool_call' })),
  }));
}

function appendToolMessage(messages: BaseMessage[], toolCallId: string, content: string): void {
  messages.push(new ToolMessage({ tool_call_id: toolCallId, content }));
}

function assertLimits(limits: AgentLoopLimits): void {
  for (const [name, value] of [
    ['maxIterations', limits.maxIterations],
    ['maxToolCalls', limits.maxToolCalls],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isContextOverflowError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.code === 'context_overflow' || candidate.name === 'ContextOverflowError';
}
