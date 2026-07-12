import type { AgentMessage, AgentToolInvocation } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import {
  MessageGroupBuilder,
  messagesInGroup,
  type BlockedMessageGroup,
  type MessageGroup,
} from '../context/message-group-builder.js';

export type SessionContextStore = Pick<AgentStore,
  | 'listSessionMessages'
  | 'listSessionToolInvocations'
>;

export interface SessionContextFacts {
  messages: AgentMessage[];
  invocations: AgentToolInvocation[];
  groups: MessageGroup[];
  blocked: BlockedMessageGroup[];
}

export class IncompleteMessageGroupError extends Error {
  readonly code = 'incomplete_message_group';

  constructor(message: string) {
    super(message);
    this.name = 'IncompleteMessageGroupError';
  }
}

export class SessionContextLoader {
  constructor(private readonly store: SessionContextStore) {}

  async load(sessionId: string): Promise<SessionContextFacts> {
    const [messages, invocations] = await Promise.all([
      this.store.listSessionMessages(sessionId),
      this.store.listSessionToolInvocations(sessionId),
    ]);
    const built = new MessageGroupBuilder().build(messages, invocations);
    return {
      messages,
      invocations,
      groups: built.groups.filter(isModelVisibleGroup),
      blocked: built.blocked,
    };
  }
}

export function isModelVisibleGroup(group: MessageGroup): boolean {
  const messages = messagesInGroup(group);
  return !messages.some(message => (
    message.visibility === 'internal'
    || message.messageType === 'progress'
  ));
}

export function assertNoBlockedGroups(
  blocked: BlockedMessageGroup[],
  predicate: (blocked: BlockedMessageGroup) => boolean
): void {
  const relevant = blocked.find(predicate);
  if (!relevant) return;
  throw new IncompleteMessageGroupError(
    `Tool exchange ${JSON.stringify(relevant.callMessage.id)} is incomplete: ${relevant.reason}.`
  );
}
