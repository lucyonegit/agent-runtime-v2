export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type AgentMessageChannel = 'normal' | 'thought' | 'final';
export type AgentMessageKind =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'system_prompt'
  | 'planner_step_input'
  | 'plan'
  | 'plan_update'
  | 'step_result'
  | 'planner_final';
export type AgentMessageVisibility = 'ui' | 'internal';

export const AGENT_MESSAGE_KINDS: AgentMessageKind[] = [
  'message',
  'tool_call',
  'tool_result',
  'system_prompt',
  'planner_step_input',
  'plan',
  'plan_update',
  'step_result',
  'planner_final',
];

export const AGENT_MESSAGE_VISIBILITIES: AgentMessageVisibility[] = ['ui', 'internal'];

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentToolResult {
  toolCallId: string;
  toolName: string;
  status: 'completed' | 'failed';
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface AgentMessage {
  rowId: number;
  id: string;
  sessionId: string;
  taskId: string;
  planId?: string;
  stepId?: string;
  outputId?: string;
  role: AgentMessageRole;
  messageKind?: AgentMessageKind;
  visibility?: AgentMessageVisibility;
  channel?: AgentMessageChannel;
  content: string;
  toolCalls?: AgentToolCall[];
  toolResult?: AgentToolResult;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface AgentMessageKindSource {
  role: AgentMessageRole;
  channel?: AgentMessageChannel;
  toolCalls?: AgentToolCall[];
  toolResult?: AgentToolResult;
  metadata?: Record<string, unknown>;
}

export function isAgentMessageKind(value: unknown): value is AgentMessageKind {
  return typeof value === 'string' && AGENT_MESSAGE_KINDS.includes(value as AgentMessageKind);
}

export function isAgentMessageVisibility(value: unknown): value is AgentMessageVisibility {
  return typeof value === 'string'
    && AGENT_MESSAGE_VISIBILITIES.includes(value as AgentMessageVisibility);
}

export function inferAgentMessageKind(input: AgentMessageKindSource): AgentMessageKind {
  if (isAgentMessageKind(input.metadata?.kind)) {
    return input.metadata.kind;
  }
  if (input.role === 'tool' && input.toolResult) {
    return 'tool_result';
  }
  if (input.role === 'assistant' && input.toolCalls && input.toolCalls.length > 0) {
    return 'tool_call';
  }
  if (
    input.role === 'assistant'
    && input.channel === 'final'
    && typeof input.metadata?.stepId === 'string'
  ) {
    return 'step_result';
  }
  return 'message';
}

export function inferAgentMessageVisibility(input: AgentMessageKindSource & {
  messageKind?: AgentMessageKind;
}): AgentMessageVisibility {
  if (isAgentMessageVisibility(input.metadata?.visibility)) {
    return input.metadata.visibility;
  }

  const messageKind = input.messageKind ?? inferAgentMessageKind(input);
  if (
    input.role === 'system'
    || messageKind === 'system_prompt'
    || messageKind === 'planner_step_input'
  ) {
    return 'internal';
  }
  return 'ui';
}
