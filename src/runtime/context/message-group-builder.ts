import type { AgentMessage, AgentToolInvocation } from '../../domain/index.js';

export type MessageGroup =
  | { id: string; type: 'single'; messages: [AgentMessage] }
  | {
      id: string;
      type: 'tool_exchange';
      callMessage: AgentMessage;
      invocations: AgentToolInvocation[];
      resultMessages: AgentMessage[];
    }
  | { id: string; type: 'step_output'; messages: [AgentMessage] };

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

export class MessageGroupBuilder {
  build(
    messages: AgentMessage[],
    invocations: AgentToolInvocation[]
  ): MessageGroupBuildResult {
    const orderedMessages = [...messages].sort((left, right) => left.rowId - right.rowId);
    const messagesById = new Map(orderedMessages.map(message => [message.id, message]));
    const invocationsByCallMessage = new Map<string, AgentToolInvocation[]>();
    for (const invocation of invocations) {
      const values = invocationsByCallMessage.get(invocation.callMessageId) ?? [];
      values.push(invocation);
      invocationsByCallMessage.set(invocation.callMessageId, values);
    }
    const consumedResultIds = new Set<string>();
    const groups: MessageGroup[] = [];
    const blocked: BlockedMessageGroup[] = [];

    for (const message of orderedMessages) {
      if (consumedResultIds.has(message.id) || message.messageType === 'tool_result') continue;
      if (message.messageType === 'step_output') {
        groups.push({ id: `step_output:${message.id}`, type: 'step_output', messages: [message] });
        continue;
      }
      if (message.messageType !== 'tool_call') {
        groups.push({ id: `message:${message.id}`, type: 'single', messages: [message] });
        continue;
      }
      if (!message.toolCalls?.length) {
        blocked.push({ callMessage: message, reason: 'missing_tool_calls' });
        continue;
      }
      const candidates = invocationsByCallMessage.get(message.id) ?? [];
      const byToolCallId = new Map(candidates.map(invocation => [invocation.toolCallId, invocation]));
      const groupInvocations: AgentToolInvocation[] = [];
      const resultMessages: AgentMessage[] = [];
      let failure: BlockedMessageGroup | undefined;
      for (const toolCall of message.toolCalls) {
        const invocation = byToolCallId.get(toolCall.id);
        if (!invocation) {
          failure = { callMessage: message, reason: 'missing_invocation', toolCallId: toolCall.id };
          break;
        }
        if (!['completed', 'failed'].includes(invocation.status)) {
          failure = {
            callMessage: message,
            reason: 'invocation_not_terminal',
            toolCallId: toolCall.id,
          };
          break;
        }
        const resultMessage = invocation.resultMessageId
          ? messagesById.get(invocation.resultMessageId)
          : undefined;
        if (!resultMessage) {
          failure = {
            callMessage: message,
            reason: 'missing_result_message',
            toolCallId: toolCall.id,
          };
          break;
        }
        if (
          resultMessage.messageType !== 'tool_result'
          || resultMessage.toolCallId !== invocation.toolCallId
          || resultMessage.toolName !== invocation.toolName
        ) {
          failure = {
            callMessage: message,
            reason: 'result_protocol_mismatch',
            toolCallId: toolCall.id,
          };
          break;
        }
        groupInvocations.push(invocation);
        resultMessages.push(resultMessage);
      }
      if (failure) {
        blocked.push(failure);
        continue;
      }
      resultMessages.forEach(result => consumedResultIds.add(result.id));
      groups.push({
        id: `tool_exchange:${message.id}`,
        type: 'tool_exchange',
        callMessage: message,
        invocations: groupInvocations,
        resultMessages,
      });
    }
    return { groups, blocked };
  }
}

export function messagesInGroup(group: MessageGroup): AgentMessage[] {
  return group.type === 'tool_exchange'
    ? [group.callMessage, ...group.resultMessages]
    : group.messages;
}
