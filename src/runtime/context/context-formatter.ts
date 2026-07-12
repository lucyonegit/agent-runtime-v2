import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AgentMessage } from '../../domain/index.js';
import type { MessageGroup } from './message-group-builder.js';

export class ContextFormatter {
  formatGroup(group: MessageGroup): BaseMessage[] {
    if (group.type === 'tool_exchange') {
      return [
        new AIMessage({
          content: group.callMessage.content,
          tool_calls: (group.callMessage.toolCalls ?? []).map(call => ({
            ...call,
            type: 'tool_call',
          })),
        }),
        ...group.resultMessages.map(message => new ToolMessage({
          tool_call_id: message.toolCallId!,
          name: message.toolName,
          content: message.content,
        })),
      ];
    }
    return [formatMessage(group.messages[0])];
  }
}

function formatMessage(message: AgentMessage): BaseMessage {
  switch (message.role) {
    case 'system':
      return new SystemMessage(message.content);
    case 'user':
      return new HumanMessage(message.content);
    case 'tool':
      return new ToolMessage({
        tool_call_id: message.toolCallId!,
        name: message.toolName,
        content: message.content,
      });
    case 'assistant':
      return new AIMessage(message.content);
  }
}
