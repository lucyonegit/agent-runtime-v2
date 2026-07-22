import type {
  AgentArtifact,
  AgentContextSummary,
  AgentJob,
  AgentMessage,
  AgentPlan,
  AgentPlanStep,
  AgentToolInvocation,
  AgentUserInputRequest,
} from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { CONTEXT_RULES_VERSION } from '../context/context-compiler.js';
import {
  MessageGroupBuilder,
  messagesInGroup,
  type BlockedMessageGroup,
  type MessageGroup,
} from '../context/message-group-builder.js';
import { TurnBundleBuilder } from '../context/turn-bundle-builder.js';
import type { TurnBundle } from '../context/context-material.js';

export type SessionContextStore = Pick<AgentStore,
  | 'listSessionJobs'
  | 'listSessionMessages'
  | 'listSessionToolInvocations'
  | 'listActiveContextSummaries'
> & Partial<Pick<AgentStore,
  | 'listSessionPlans'
  | 'listSessionPlanSteps'
  | 'listSessionArtifacts'
  | 'listSessionUserInputRequests'
>>;

export interface SessionContextFacts {
  jobs: AgentJob[];
  messages: AgentMessage[];
  invocations: AgentToolInvocation[];
  summaries: AgentContextSummary[];
  plans: AgentPlan[];
  planSteps: AgentPlanStep[];
  artifacts: AgentArtifact[];
  userInputRequests: AgentUserInputRequest[];
  groups: MessageGroup[];
  bundles: TurnBundle[];
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
    const [
      jobs, messages, invocations, summaries, plans, planSteps, artifacts, userInputRequests,
    ] = await Promise.all([
      this.store.listSessionJobs(sessionId),
      this.store.listSessionMessages(sessionId),
      this.store.listSessionToolInvocations(sessionId),
      this.store.listActiveContextSummaries(
        'session', sessionId, 'conversation', CONTEXT_RULES_VERSION
      ),
      this.store.listSessionPlans?.(sessionId) ?? Promise.resolve([]),
      this.store.listSessionPlanSteps?.(sessionId) ?? Promise.resolve([]),
      this.store.listSessionArtifacts?.(sessionId) ?? Promise.resolve([]),
      this.store.listSessionUserInputRequests?.(sessionId) ?? Promise.resolve([]),
    ]);
    const builder = new MessageGroupBuilder();
    const built = builder.build(messages, invocations);
    const groups = built.groups.filter(isModelVisibleGroup);
    return {
      jobs,
      messages,
      invocations,
      summaries,
      plans,
      planSteps,
      artifacts,
      userInputRequests,
      groups,
      bundles: new TurnBundleBuilder().build({ sessionId, jobs, groups }),
      blocked: built.blocked,
    };
  }
}

function isModelVisibleGroup(group: MessageGroup): boolean {
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
