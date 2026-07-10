import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentModelTokenUsage, AgentToolCall } from '../../domain/index.js';
import {
  CoreStepEventType,
  type CoreStepEvent,
  type CoreToolInputRequest,
} from './events.js';

export interface ReactCoreModel {
  invoke(messages: BaseMessage[]): Promise<AIMessage>;
  stream?(messages: BaseMessage[]): AsyncIterable<ReactCoreStreamChunk>;
}

export interface ReactCoreStreamChunk {
  content?: unknown;
  tool_call_chunks?: ReactCoreToolCallChunk[];
  usage?: AgentModelTokenUsage;
}

export interface ReactCoreToolCallChunk {
  index?: number;
  id?: string;
  name?: string;
  args?: string;
}

interface AccumulatedToolCall {
  index: number;
  id: string;
  name: string;
  args: string;
}

type ToolExecutionOutcome =
  | {
      type: 'result';
      call: AgentToolCall;
      event: Extract<
        CoreStepEvent,
        { type: CoreStepEventType.ToolResultCompleted | CoreStepEventType.ToolResultFailed }
      >;
      toolMessageContent: string;
    }
  | {
      type: 'input_required';
      call: AgentToolCall;
      event: Extract<CoreStepEvent, { type: CoreStepEventType.ToolInputRequired }>;
    };

type ModelStepOutcome = 'continue' | 'stop';

export type ToolExecutionResult =
  | {
      type: 'completed';
      content: string;
      result?: unknown;
    }
  | {
      type: 'failed';
      error: string;
      details?: unknown;
    }
  | {
      type: 'requires_user_input';
      request: CoreToolInputRequest;
    };

export interface ReactCoreTool {
  name: string;
  execute(args: Record<string, unknown>, context: ReactCoreToolContext): Promise<ToolExecutionResult>;
}

export interface ReactCoreToolContext {
  sessionId: string;
  taskId: string;
  sandboxRoot: string;
  projectId?: string;
}

export interface ReactCoreConfig {
  model: ReactCoreModel;
  tools: ReactCoreTool[];
  streaming?: boolean;
  maxIterations?: number;
}

export class ReactCore {
  private readonly toolsByName: Map<string, ReactCoreTool>;
  private outputSeq = 0;

  constructor(private readonly config: ReactCoreConfig) {
    this.toolsByName = new Map(config.tools.map(tool => [tool.name, tool]));
  }

  async *run(input: {
    messages: BaseMessage[];
    toolContext?: ReactCoreToolContext;
  }): AsyncIterable<CoreStepEvent> {
    const messages = [...input.messages];
    const maxIterations = this.config.maxIterations ?? 8;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (this.config.streaming && this.config.model.stream) {
        const outcome = yield* this.readStream(messages, input.toolContext);
        if (outcome === 'stop') {
          return;
        }
        continue;
      }

      const response = await this.config.model.invoke(messages);
      const content = typeof response.content === 'string' ? response.content : '';
      const toolCalls = this.extractToolCalls(response);
      const outputId = this.createOutputId();
      const usage = this.extractUsage(response);

      const outcome = yield* this.handleModelTurnResult(
        messages,
        content,
        toolCalls,
        outputId,
        usage,
        input.toolContext
      );
      if (outcome === 'stop') {
        return;
      }
    }
  }

  private extractToolCalls(message: AIMessage): AgentToolCall[] {
    return (message.tool_calls ?? []).map(call => ({
      id: call.id ?? `call_${Date.now()}`,
      name: call.name,
      args: call.args as Record<string, unknown>,
    }));
  }

  private async *readStream(
    messages: BaseMessage[],
    toolContext?: ReactCoreToolContext
  ): AsyncGenerator<CoreStepEvent, ModelStepOutcome> {
    const outputId = this.createOutputId();
    let content = '';
    let accumulatedToolCalls: AccumulatedToolCall[] = [];
    let usage: AgentModelTokenUsage | undefined;
    for await (const chunk of this.config.model.stream!(messages)) {
      usage = chunk.usage ?? usage;
      const delta = typeof chunk.content === 'string' ? chunk.content : '';
      if (delta) {
        content += delta;
        yield {
          type: CoreStepEventType.ModelOutputDelta,
          outputId,
          channel: 'normal',
          delta,
        };
      }

      if (chunk.tool_call_chunks?.length) {
        accumulatedToolCalls = this.mergeToolCallChunks(accumulatedToolCalls, chunk.tool_call_chunks);
      }
    }

    const toolCalls = this.toToolCalls(accumulatedToolCalls);
    const outcome = yield* this.handleModelTurnResult(messages, content, toolCalls, outputId, usage, toolContext);
    return outcome;
  }

  private async *handleModelTurnResult(
    messages: BaseMessage[],
    content: string,
    toolCalls: AgentToolCall[],
    outputId: string,
    usage?: AgentModelTokenUsage,
    toolContext?: ReactCoreToolContext
  ): AsyncGenerator<CoreStepEvent, ModelStepOutcome> {
    if (toolCalls.length === 0) {
      if (content.trim().length === 0) {
        return 'stop';
      }

      yield {
        type: CoreStepEventType.ModelOutputCompleted,
        outputId,
        channel: 'final',
        content,
        usage,
      };
      this.appendAssistantMessage(messages, content);
      return 'stop';
    }

    const outcomes: ToolExecutionOutcome[] = [];
    for (const call of toolCalls) {
      const tool = this.toolsByName.get(call.name);
      const startedAt = Date.now();

      if (!tool) {
        const error = `Tool not found: ${call.name}`;
        outcomes.push({
          type: 'result',
          call,
          toolMessageContent: error,
          event: {
            type: CoreStepEventType.ToolResultFailed,
            toolCallId: call.id,
            toolName: call.name,
            error,
            durationMs: Date.now() - startedAt,
          },
        });
        continue;
      }

      if (!toolContext) {
        const error = 'Tool context is required to execute tools';
        outcomes.push({
          type: 'result',
          call,
          toolMessageContent: error,
          event: {
            type: CoreStepEventType.ToolResultFailed,
            toolCallId: call.id,
            toolName: call.name,
            error,
            durationMs: Date.now() - startedAt,
          },
        });
        continue;
      }

      const result = await tool.execute(call.args, toolContext);
      const durationMs = Date.now() - startedAt;

      if (result.type === 'requires_user_input') {
        outcomes.push({
          type: 'input_required',
          call,
          event: {
            type: CoreStepEventType.ToolInputRequired,
            toolCallId: call.id,
            toolName: call.name,
            request: result.request,
          },
        });
        continue;
      }

      if (result.type === 'failed') {
        outcomes.push({
          type: 'result',
          call,
          toolMessageContent: result.error,
          event: {
            type: CoreStepEventType.ToolResultFailed,
            toolCallId: call.id,
            toolName: call.name,
            error: result.error,
            details: result.details,
            durationMs,
          },
        });
        continue;
      }

      outcomes.push({
        type: 'result',
        call,
        toolMessageContent: result.content,
        event: {
          type: CoreStepEventType.ToolResultCompleted,
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          result: result.result,
          durationMs,
        },
      });
    }

    const modelOutputEvent: Extract<CoreStepEvent, { type: CoreStepEventType.ModelOutputCompleted }> = {
      type: CoreStepEventType.ModelOutputCompleted,
      outputId,
      channel: 'normal',
      content,
      toolCalls,
      usage,
    };
    yield modelOutputEvent;
    this.appendAssistantToolCalls(messages, content, toolCalls);

    const hasPendingInput = yield* this.emitToolOutcomes(messages, outcomes);
    return hasPendingInput ? 'stop' : 'continue';
  }

  private async *emitToolOutcomes(
    messages: BaseMessage[],
    outcomes: ToolExecutionOutcome[]
  ): AsyncGenerator<CoreStepEvent, boolean> {
    for (const outcome of outcomes) {
      if (this.isInputRequiredOutcome(outcome)) {
        continue;
      }
      yield outcome.event;
      this.appendToolMessage(messages, outcome.call.id, outcome.toolMessageContent);
    }

    const pendingInputOutcomes = outcomes.filter(outcome => this.isInputRequiredOutcome(outcome));
    for (const outcome of pendingInputOutcomes) {
      yield outcome.event;
    }

    return pendingInputOutcomes.length > 0;
  }

  private isInputRequiredOutcome(
    outcome: ToolExecutionOutcome
  ): outcome is Extract<ToolExecutionOutcome, { type: 'input_required' }> {
    return outcome.type === 'input_required';
  }

  private createOutputId(): string {
    this.outputSeq += 1;
    return `output_${this.outputSeq}`;
  }

  private appendAssistantToolCalls(messages: BaseMessage[], content: string, toolCalls: AgentToolCall[]): void {
    messages.push(new AIMessage({
      content,
      tool_calls: toolCalls.map(call => ({
        ...call,
        type: 'tool_call',
      })),
    }));
  }

  private appendAssistantMessage(messages: BaseMessage[], content: string): void {
    messages.push(new AIMessage(content));
  }

  private appendToolMessage(messages: BaseMessage[], toolCallId: string, content: string): void {
    messages.push(new ToolMessage({
      tool_call_id: toolCallId,
      content,
    }));
  }

  private mergeToolCallChunks(
    accumulated: AccumulatedToolCall[],
    chunks: ReactCoreToolCallChunk[]
  ): AccumulatedToolCall[] {
    for (const chunk of chunks) {
      const index = chunk.index ?? 0;
      let toolCall = accumulated.find(item => item.index === index);
      if (!toolCall) {
        toolCall = {
          index,
          id: chunk.id ?? '',
          name: chunk.name ?? '',
          args: chunk.args ?? '',
        };
        accumulated.push(toolCall);
      } else {
        if (chunk.id) toolCall.id = chunk.id;
        if (chunk.name) toolCall.name = chunk.name;
        if (chunk.args) toolCall.args += chunk.args;
      }
    }

    return accumulated;
  }

  private toToolCalls(accumulated: AccumulatedToolCall[]): AgentToolCall[] {
    return accumulated
      .filter(call => call.name)
      .map(call => {
        try {
          const parsed = call.args.trim().length > 0 ? JSON.parse(call.args) : {};
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
          }
          return {
            id: call.id || `call_${call.index}`,
            name: call.name,
            args: parsed as Record<string, unknown>,
          };
        } catch {
          return null;
        }
      })
      .filter((call): call is AgentToolCall => call !== null);
  }

  private extractUsage(message: AIMessage): AgentModelTokenUsage | undefined {
    const value = message as unknown as {
      usage_metadata?: unknown;
      response_metadata?: unknown;
    };
    return normalizeTokenUsage(value.usage_metadata)
      ?? normalizeTokenUsage((value.response_metadata as { tokenUsage?: unknown; usage?: unknown } | undefined)?.tokenUsage)
      ?? normalizeTokenUsage((value.response_metadata as { tokenUsage?: unknown; usage?: unknown } | undefined)?.usage);
  }
}

function normalizeTokenUsage(value: unknown): AgentModelTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = readNumber(value, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const outputTokens = readNumber(value, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  const totalTokens = readNumber(value, ['total_tokens', 'totalTokens']);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? sumIfKnown(inputTokens, outputTokens),
    source: 'provider',
  };
}

function readNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function sumIfKnown(left?: number, right?: number): number | undefined {
  return left === undefined || right === undefined ? undefined : left + right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
