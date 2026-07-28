import type { AgentArtifact, AgentMessage, AgentToolCall } from '../domain/index.js';
import type { FlatTimelineItem } from './view-contract.js';

export interface TimelineBuilderInput {
  messages: AgentMessage[];
  toolCalls: AgentToolCall[];
  artifacts: AgentArtifact[];
}

/** Projects the canonical message sequence; plans are separate durable view data. */
export class TimelineBuilder {
  build(input: TimelineBuilderInput): { flat: FlatTimelineItem[] } {
    return { flat: buildFlat(input.messages, input.toolCalls, input.artifacts) };
  }
}

function buildFlat(
  messages: AgentMessage[],
  toolCalls: AgentToolCall[],
  artifacts: AgentArtifact[]
): FlatTimelineItem[] {
  const ordered = [...messages].sort((left, right) => left.rowId - right.rowId);
  const messagesById = new Map(ordered.map(message => [message.id, message]));
  const toolCallsByMessage = groupBy(toolCalls, toolCall => toolCall.callMessageId);
  const artifactsByToolCall = groupBy(artifacts, artifact => artifact.toolCallId);
  const consumed = new Set<string>();
  const flat: FlatTimelineItem[] = [];
  for (const message of ordered) {
    if (consumed.has(message.id)) continue;
    if (message.messageType !== 'tool_call') {
      flat.push({ type: 'message', rowId: message.rowId, message });
      continue;
    }
    const messageToolCalls = toolCallsByMessage.get(message.id) ?? [];
    const resultMessages = messageToolCalls
      .map(toolCall => toolCall.resultMessageId && messagesById.get(toolCall.resultMessageId))
      .filter((result): result is AgentMessage => Boolean(result));
    resultMessages.forEach(result => consumed.add(result.id));
    // ActivePlan owns the structured plan card. Preserve only the model's
    // user-facing working note so completed Tasks still have a readable story.
    if (isPlanUpdate(message, messageToolCalls)) {
      if (message.content.trim()) {
        flat.push({ type: 'message', rowId: message.rowId, message });
      }
      continue;
    }
    const status = aggregateToolStatus(messageToolCalls);
    const toolArtifacts = messageToolCalls.flatMap(
      toolCall => artifactsByToolCall.get(toolCall.id) ?? []
    );
    flat.push({
      type: 'tool_exchange',
      rowId: message.rowId,
      callMessage: message,
      toolCalls: messageToolCalls,
      resultMessages,
      artifacts: toolArtifacts,
      status,
      ...(status === 'outcome_unknown'
        ? { warning: 'Tool outcome is unknown and requires recovery confirmation.' }
        : {}),
    });
  }
  return flat;
}

function isPlanUpdate(message: AgentMessage, toolCalls: AgentToolCall[]): boolean {
  if (toolCalls.length > 0) return toolCalls.every(toolCall => toolCall.toolName === 'update_plan');
  const modelToolCalls = message.toolCalls ?? [];
  return modelToolCalls.length > 0 && modelToolCalls.every(call => call.name === 'update_plan');
}

function aggregateToolStatus(toolCalls: AgentToolCall[]): AgentToolCall['status'] {
  const statuses = new Set(toolCalls.map(toolCall => toolCall.status));
  for (const status of [
    'outcome_unknown', 'waiting_for_user', 'running', 'pending', 'failed', 'cancelled',
  ] as const) {
    if (statuses.has(status)) return status;
  }
  return 'completed';
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = groups.get(key(item)) ?? [];
    value.push(item);
    groups.set(key(item), value);
  }
  return groups;
}
