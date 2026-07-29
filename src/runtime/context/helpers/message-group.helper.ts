import type { AgentMessage } from '../../../domain/index.js';
import { estimateTextTokens } from './token-budget.helper.js';
import type { ModelMessageGroup } from '../types/model-input.types.js';

export interface MessageGroupProjection {
  groups: ModelMessageGroup[];
  excludedToolCallMessageIds: string[];
}

/** Owns protocol-safe Message -> model-group projection for Context. */
export function projectMessageGroups(messages: AgentMessage[]): MessageGroupProjection {
  const ordered = [...messages].sort((left, right) => left.rowId - right.rowId);
  const toolResults = new Map<string, AgentMessage[]>();
  const toolCallKeyCounts = new Map<string, number>();
  for (const message of ordered) {
    if (message.role === 'tool' && message.modelToolCallId) {
      const key = toolCallKey(message.taskId, message.modelToolCallId);
      toolResults.set(key, [...toolResults.get(key) ?? [], message]);
      continue;
    }
    for (const call of message.toolCalls ?? []) {
      const key = toolCallKey(message.taskId, call.id);
      toolCallKeyCounts.set(key, (toolCallKeyCounts.get(key) ?? 0) + 1);
    }
  }

  const groups: ModelMessageGroup[] = [];
  const excludedToolCallMessageIds: string[] = [];

  for (const message of ordered) {
    if (message.role === 'tool') continue;
    if (message.toolCalls?.length) {
      const callIds = message.toolCalls.map(call => call.id);
      const hasDuplicateCallId = new Set(callIds).size !== callIds.length;
      const results = message.toolCalls.map(call => {
        const key = toolCallKey(message.taskId, call.id);
        if (toolCallKeyCounts.get(key) !== 1) return undefined;
        const candidates = toolResults.get(key) ?? [];
        if (candidates.length !== 1) return undefined;
        const result = candidates[0]!;
        return result.rowId > message.rowId
          && (result.toolName === undefined || result.toolName === call.name)
          ? result
          : undefined;
      });
      if (hasDuplicateCallId || results.some(result => !result)) {
        excludedToolCallMessageIds.push(message.id);
        continue;
      }
      const complete = [message, ...results as AgentMessage[]];
      groups.push(toGroup(message.id, complete));
      continue;
    }
    groups.push(toGroup(message.id, [message]));
  }

  return { groups, excludedToolCallMessageIds };
}

function toolCallKey(taskId: string, modelToolCallId: string): string {
  return `${taskId}\u0000${modelToolCallId}`;
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
