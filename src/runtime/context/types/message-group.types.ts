import type {
  AgentMessage,
  AgentToolInvocation,
} from '../../../domain/index.js';

export interface RuntimeRefs {
  sessionId: string;
  jobId: string;
  planId?: string;
  planStepId?: string;
}

export type MessageGroup =
  | { id: string; type: 'single'; messages: [AgentMessage] }
  | {
      id: string;
      type: 'tool_exchange';
      callMessage: AgentMessage;
      invocations: AgentToolInvocation[];
      resultMessages: AgentMessage[];
      refs: RuntimeRefs;
    };

export interface BlockedMessageGroup {
  callMessage: AgentMessage;
  reason:
    | 'missing_tool_calls'
    | 'missing_invocation'
    | 'invocation_not_terminal'
    | 'missing_result_message'
    | 'result_protocol_mismatch';
  toolCallId?: string;
}

export interface MessageGroupBuildResult {
  groups: MessageGroup[];
  blocked: BlockedMessageGroup[];
}
