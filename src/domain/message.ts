import type { ToolCall } from '@langchain/core/messages';

export const AGENT_MESSAGE_CHANNELS = ['normal', 'progress', 'final'] as const;
export type AgentMessageChannel = typeof AGENT_MESSAGE_CHANNELS[number];

const AGENT_MESSAGE_TYPES = [
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'system_prompt',
  'progress',
  'error_notice',
  'code_artifact',
] as const;

export type AgentMessageType = typeof AGENT_MESSAGE_TYPES[number];
export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type AgentMessageVisibility = 'ui' | 'internal';

export type AgentToolCall = ToolCall & { id: string };

export interface AgentToolResult {
  status: 'completed' | 'failed';
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface AgentMessage {
  rowId: number;
  id: string;
  sessionId: string;
  jobId: string;
  planId?: string;
  planStepId?: string;
  attemptId?: string;
  outputId?: string;
  role: AgentMessageRole;
  messageType: AgentMessageType;
  visibility: AgentMessageVisibility;
  channel?: AgentMessageChannel;
  content: string;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  toolName?: string;
  toolResult?: AgentToolResult;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
}
