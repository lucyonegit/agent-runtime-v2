export type AgentInputSource = 'tool' | 'agent' | 'planner';
export type AgentInputRequestStatus = 'pending' | 'answered' | 'cancelled' | 'expired';
export type AgentInputResumeMode = 'answer_as_tool_result' | 'answer_as_user_input';

export type AgentInputSchema =
  | { type: 'text'; placeholder?: string; defaultValue?: string }
  | { type: 'single_choice'; options: Array<{ label: string; value: string }> }
  | { type: 'multi_choice'; options: Array<{ label: string; value: string }> }
  | { type: 'approval'; approveLabel?: string; rejectLabel?: string };

export interface AgentInputRequest {
  id: string;
  sessionId: string;
  taskId: string;
  planId?: string;
  stepId?: string;
  source: AgentInputSource;
  toolCallMessageId?: string;
  toolCallId?: string;
  toolName?: string;
  resumeMode: AgentInputResumeMode;
  status: AgentInputRequestStatus;
  title?: string;
  prompt: string;
  input: AgentInputSchema;
  answer?: {
    value: unknown;
    messageId?: string;
    answeredAt: number;
  };
  createdAt: number;
  updatedAt: number;
}
