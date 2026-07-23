import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type {
  AIMessageChunk,
  InvalidToolCall,
  ToolCall,
  UsageMetadata,
} from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { AgentToolCall } from '../../domain/index.js';
import type { LoopFailureCode } from './loop-result.js';

export type LangChainChatRunnable = Runnable<BaseLanguageModelInput, AIMessageChunk>;

export interface LangChainToolCallError {
  code: Extract<LoopFailureCode, 'invalid_tool_arguments' | 'model_error'>;
  call: AgentToolCall;
  message: string;
  details: { index: number; reason: string };
}

export interface LangChainModelTurn {
  content: string;
  toolCalls: AgentToolCall[];
  errors: LangChainToolCallError[];
  usage?: UsageMetadata;
  finishReason?: string;
}

export function readLangChainModelTurn(
  message: AIMessageChunk,
  outputId: string
): LangChainModelTurn {
  const toolCalls = (message.tool_calls ?? []).map((call, index) => requireToolCallId(
    call,
    `${outputId}_call_${index}`
  ));
  const errors = (message.invalid_tool_calls ?? []).map((call, index) => (
    invalidToolCallError(call, index, `${outputId}_invalid_${index}`)
  ));
  return {
    content: message.text,
    toolCalls: [...toolCalls, ...errors.map(error => error.call)],
    errors,
    ...(message.usage_metadata ? { usage: message.usage_metadata } : {}),
    ...(finishReason(message.response_metadata) ? {
      finishReason: finishReason(message.response_metadata),
    } : {}),
  };
}

function finishReason(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.finish_reason ?? metadata.stop_reason;
  return typeof value === 'string' && value ? value : undefined;
}

function requireToolCallId(call: ToolCall, fallbackId: string): AgentToolCall {
  return {
    type: 'tool_call',
    id: call.id ?? fallbackId,
    name: call.name,
    args: call.args,
  };
}

function invalidToolCallError(
  call: InvalidToolCall,
  index: number,
  fallbackId: string
): LangChainToolCallError {
  const normalized: AgentToolCall = {
    type: 'tool_call',
    id: call.id ?? fallbackId,
    name: call.name ?? `invalid_tool_${index}`,
    args: {},
  };
  return {
    code: 'invalid_tool_arguments',
    call: normalized,
    message: call.error || `Tool ${JSON.stringify(normalized.name)} returned invalid arguments.`,
    details: { index, reason: call.error || 'invalid_tool_arguments' },
  };
}
