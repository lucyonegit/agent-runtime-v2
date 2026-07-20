export type AgentUserInputSource = 'tool' | 'agent' | 'recovery';
export type AgentUserInputAnswerMode = 'as_tool_result' | 'as_user_message';
export type AgentUserInputStatus = 'pending' | 'answered' | 'cancelled' | 'expired';

export type AgentUserInputSchema =
  | { type: 'text'; placeholder?: string; defaultValue?: string; maxLength?: number }
  | { type: 'single_choice'; options: Array<{ label: string; value: string }> }
  | {
      type: 'multi_choice';
      min?: number;
      max?: number;
      options: Array<{ label: string; value: string }>;
    }
  | { type: 'approval'; approveLabel?: string; rejectLabel?: string };

export interface AgentUserInputRequest {
  id: string;
  sessionId: string;
  jobId: string;
  planId?: string;
  planStepId?: string;
  toolInvocationId?: string;
  source: AgentUserInputSource;
  answerMode: AgentUserInputAnswerMode;
  status: AgentUserInputStatus;
  title?: string;
  prompt: string;
  inputSchema: AgentUserInputSchema;
  answer?: unknown;
  answerMessageId?: string;
  clientAnswerId?: string;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  answeredAtMs?: number;
}

export function isValidAnswerModeForSource(
  source: AgentUserInputSource,
  answerMode: AgentUserInputAnswerMode
): boolean {
  return source !== 'tool' || answerMode === 'as_tool_result';
}
