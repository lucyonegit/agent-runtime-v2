export type AgentUserInputStatus = 'pending' | 'answered' | 'cancelled' | 'expired';

export type AgentUserInputSchema =
  | { type: 'text'; placeholder?: string; defaultValue?: string; maxLength?: number }
  | { type: 'single_choice'; options: Array<{ label: string; value: string }> }
  | {
      type: 'multi_choice';
      min?: number;
      max?: number;
      options: Array<{ label: string; value: string }>;
    };

/** request_user_input is the only producer; the answer is committed as ToolMessage. */
export interface AgentUserInputRequest {
  id: string;
  sessionId: string;
  taskId: string;
  toolCallId: string;
  status: AgentUserInputStatus;
  title?: string;
  prompt: string;
  inputSchema: AgentUserInputSchema;
  answerMessageId?: string;
  clientAnswerId?: string;
  expiresAtMs?: number;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  answeredAtMs?: number;
}
