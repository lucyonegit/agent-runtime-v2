import type { BaseMessage } from '@langchain/core/messages';
import type { AgentToolCall, AgentToolSideEffectLevel } from '../domain/index.js';

export interface ProviderTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  source: 'provider' | 'estimated' | 'mixed' | 'unavailable';
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  sideEffectLevel: AgentToolSideEffectLevel;
  sensitiveArgumentPaths?: string[];
}

export interface ModelToolCall {
  id?: string;
  name?: string;
  args?: unknown;
}

export interface ModelResponse {
  content?: unknown;
  toolCalls?: ModelToolCall[];
  usage?: ProviderTokenUsage;
}

export interface ModelToolCallChunk {
  index?: number;
  id?: string;
  name?: string;
  args?: string;
}

export interface ModelStreamChunk {
  content?: unknown;
  toolCallChunks?: ModelToolCallChunk[];
  usage?: ProviderTokenUsage;
}

export interface ModelRequest {
  messages: BaseMessage[];
  tools: AgentToolDefinition[];
  signal?: AbortSignal;
}

export interface AgentLoopModelPort {
  invoke(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamChunk>;
}

export function normalizeModelToolCall(
  call: ModelToolCall,
  fallbackId: string
): AgentToolCall | undefined {
  if (!call.name || !isRecord(call.args ?? {})) return undefined;
  return {
    id: call.id || fallbackId,
    name: call.name,
    args: (call.args ?? {}) as Record<string, unknown>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
