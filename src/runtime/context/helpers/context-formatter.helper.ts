import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AgentMessage } from '../../../domain/index.js';
import type { CompiledContextAnnotation } from '../types/context.types.js';
import type { MessageGroup } from '../types/message-group.types.js';
import { ToolResultContextProjector } from './tool-result-projector.helper.js';

interface FormattedContextGroup {
  messages: BaseMessage[];
  truncatedToolResultMessageIds: string[];
  annotations: Array<Omit<CompiledContextAnnotation, 'groupId' | 'bundleId'>>;
}

export class ContextFormatter {
  readonly #toolResults: ToolResultContextProjector;

  constructor(toolResults = new ToolResultContextProjector()) {
    this.#toolResults = toolResults;
  }

  formatGroup(group: MessageGroup): BaseMessage[] {
    return this.formatGroupWithMetadata(group).messages;
  }

  formatGroupWithMetadata(group: MessageGroup): FormattedContextGroup {
    if (group.type === 'tool_exchange') {
      const projections = group.resultMessages.map(message => ({
        message,
        projection: this.#toolResults.project(message.content),
      }));
      return {
        messages: [
        new AIMessage({
          content: group.callMessage.content,
          tool_calls: (group.callMessage.toolCalls ?? []).map(call => ({
            ...call,
            type: 'tool_call',
          })),
        }),
        ...projections.map(({ message, projection }) => new ToolMessage({
          tool_call_id: message.toolCallId!,
          name: message.toolName,
          content: projection.content,
        })),
        ],
        truncatedToolResultMessageIds: projections
          .filter(({ projection }) => projection.truncated)
          .map(({ message }) => message.id),
        annotations: [
          { sourceMessageId: group.callMessage.id },
          ...projections.map(({ message, projection }) => ({
            sourceMessageId: message.id,
            projected: projection.truncated,
            truncated: projection.truncated,
            originalTokenEstimate: projection.originalTokenEstimate,
            projectedTokenEstimate: projection.projectedTokenEstimate,
            checksum: projection.checksum,
          })),
        ],
      };
    }
    return {
      messages: [formatMessage(group.messages[0])],
      truncatedToolResultMessageIds: [],
      annotations: [{ sourceMessageId: group.messages[0].id }],
    };
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
