import type { AgentMessage, AgentToolInvocation } from '../domain/index.js';
import type { FlatTimelineItem } from './view-contract.js';

export interface TimelineBuilderInput {
  messages: AgentMessage[];
  toolInvocations: AgentToolInvocation[];
}

/** Projects the canonical message sequence; plans are separate durable view data. */
export class TimelineBuilder {
  build(input: TimelineBuilderInput): { flat: FlatTimelineItem[] } {
    return { flat: buildFlat(input.messages, input.toolInvocations) };
  }
}

function buildFlat(
  messages: AgentMessage[],
  invocations: AgentToolInvocation[]
): FlatTimelineItem[] {
  const ordered = [...messages].sort((left, right) => left.rowId - right.rowId);
  const messagesById = new Map(ordered.map(message => [message.id, message]));
  const invocationsByCall = groupBy(invocations, invocation => invocation.callMessageId);
  const consumed = new Set<string>();
  const flat: FlatTimelineItem[] = [];
  for (const message of ordered) {
    if (consumed.has(message.id)) continue;
    if (message.messageType !== 'tool_call') {
      flat.push({ type: 'message', rowId: message.rowId, message });
      continue;
    }
    const toolInvocations = invocationsByCall.get(message.id) ?? [];
    const resultMessages = toolInvocations
      .map(invocation => invocation.resultMessageId && messagesById.get(invocation.resultMessageId))
      .filter((result): result is AgentMessage => Boolean(result));
    resultMessages.forEach(result => consumed.add(result.id));
    const status = aggregateToolStatus(toolInvocations);
    flat.push({
      type: 'tool_exchange',
      rowId: message.rowId,
      callMessage: message,
      invocations: toolInvocations,
      resultMessages,
      status,
      ...(status === 'unknown'
        ? { warning: 'Tool outcome is unknown and requires recovery confirmation.' }
        : {}),
    });
  }
  return flat;
}

function aggregateToolStatus(invocations: AgentToolInvocation[]):
  'pending' | 'running' | 'waiting_user_input' | 'completed' | 'failed' | 'unknown' | 'cancelled' {
  const statuses = new Set(invocations.map(invocation => invocation.status));
  for (const status of [
    'unknown', 'waiting_user_input', 'running', 'pending', 'failed', 'cancelled',
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
