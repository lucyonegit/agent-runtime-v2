import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AgentMessage } from '../../domain/index.js';
import type { MessageGroup } from './message-group-builder.js';
import { ToolResultContextProjector } from './tool-result-context-projector.js';

export interface FormattedContextGroup {
  messages: BaseMessage[];
  truncatedToolResultMessageIds: string[];
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
      };
    }
    if (group.type === 'plan_definition') {
      return {
        messages: [new AIMessage({
          content: JSON.stringify({
            type: 'plan_definition',
            plan: {
              id: group.plan.id,
              title: group.plan.title,
              goal: group.plan.goal,
              steps: group.steps.map(step => ({
                id: step.id,
                position: step.position,
                title: step.title,
                instruction: step.instruction,
              })),
            },
          }),
        })],
        truncatedToolResultMessageIds: [],
      };
    }
    if (group.type === 'step_output' && group.output && group.step && group.stepRun) {
      return {
        messages: [new AIMessage({
          content: JSON.stringify({
            type: 'step_output',
            step: {
              id: group.step.id,
              position: group.step.position,
              title: group.step.title,
            },
            stepRunId: group.stepRun.id,
            output: group.output,
          }),
        })],
        truncatedToolResultMessageIds: [],
      };
    }
    if (group.type === 'plan_final') {
      return {
        messages: [formatMessage(group.message)],
        truncatedToolResultMessageIds: [],
      };
    }
    return {
      messages: [formatMessage(group.messages[0])],
      truncatedToolResultMessageIds: [],
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
