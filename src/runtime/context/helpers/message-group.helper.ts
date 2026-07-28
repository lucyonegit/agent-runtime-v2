import type { AgentMessage } from '../../../domain/index.js';
import { estimateTextTokens } from './token-budget.helper.js';
import type { ModelMessageGroup } from '../types/model-input.types.js';

/**
 * Groups an Assistant tool-call message with every matching ToolMessage.
 * Incomplete batches and orphan ToolMessages are excluded from model input.
 */
export function buildCompleteMessageGroups(messages: AgentMessage[]): ModelMessageGroup[] {
  const ordered = [...messages].sort((left, right) => left.rowId - right.rowId);
  const toolResults = new Map(
    ordered
      .filter(message => message.role === 'tool' && message.modelToolCallId)
      .map(message => [message.modelToolCallId!, message])
  );
  const groupedResultIds = new Set<string>();
  const groups: ModelMessageGroup[] = [];

  for (const message of ordered) {
    if (message.role === 'tool') continue;
    if (message.toolCalls?.length) {
      const results = message.toolCalls.map(call => toolResults.get(call.id));
      if (results.some(result => !result)) continue;
      const complete = [message, ...results as AgentMessage[]];
      for (const result of results as AgentMessage[]) groupedResultIds.add(result.id);
      groups.push(toGroup(message.id, complete));
      continue;
    }
    groups.push(toGroup(message.id, [message]));
  }

  // A ToolMessage is protocol-valid only as part of a complete tool-call group.
  void groupedResultIds;
  return groups;
}

function toGroup(id: string, messages: AgentMessage[]): ModelMessageGroup {
  const rowIds = messages.map(message => message.rowId);
  const contextScope = messages.some(message => message.contextScope === 'task')
    ? 'task'
    : 'conversation';
  return {
    id,
    messages,
    estimatedTokens: estimateTextTokens(messages.map(serializeForEstimate).join('\n')),
    minRowId: Math.min(...rowIds),
    maxRowId: Math.max(...rowIds),
    contextScope,
  };
}

function serializeForEstimate(message: AgentMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    modelToolCallId: message.modelToolCallId,
    toolResult: message.toolResult,
  });
}
