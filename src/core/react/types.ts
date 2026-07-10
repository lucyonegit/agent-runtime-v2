export type AgentMessageChannel = 'normal' | 'progress' | 'final';
export type AgentInputSource = 'tool' | 'agent' | 'planner' | 'recovery';
export type AgentInputResumeMode = 'answer_as_tool_result' | 'answer_as_user_input';

export type AgentInputSchema =
  | { type: 'text'; placeholder?: string; defaultValue?: string; maxLength?: number }
  | { type: 'single_choice'; options: Array<{ label: string; value: string }> }
  | {
      type: 'multi_choice';
      min?: number;
      max?: number;
      options: Array<{ label: string; value: string }>;
    }
  | { type: 'approval'; approveLabel?: string; rejectLabel?: string };

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentModelTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  source: 'provider' | 'estimated' | 'mixed' | 'unavailable';
}
