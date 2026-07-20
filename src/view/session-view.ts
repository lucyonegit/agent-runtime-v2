import { AgentStoreError, type AgentStore } from '../storage/agent-store.js';
import { TimelineBuilder } from './timeline-builder.js';
import type { SessionViewV1 } from './view-contract.js';
import type { AgentMessage, AgentToolInvocation, AgentUserInputRequest } from '../domain/index.js';

export class SessionView {
  readonly #timeline = new TimelineBuilder();

  constructor(
    private readonly store: AgentStore,
    private readonly clock: { nowMs(): number } = { nowMs: () => Date.now() }
  ) {}

  async load(sessionId: string): Promise<SessionViewV1> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new AgentStoreError('SESSION_NOT_FOUND', `Agent session ${JSON.stringify(sessionId)} was not found.`);
    }
    const [
      jobs,
      plans,
      planSteps,
      allMessages,
      toolInvocations,
      artifacts,
      userInputRequests,
      modelUsage,
    ] = await Promise.all([
      this.store.listSessionJobs(sessionId),
      this.store.listSessionPlans(sessionId),
      this.store.listSessionPlanSteps(sessionId),
      this.store.listSessionMessages(sessionId),
      this.store.listSessionToolInvocations(sessionId),
      this.store.listSessionArtifacts(sessionId),
      this.store.listSessionUserInputRequests(sessionId),
      this.store.getModelUsageStats(sessionId),
    ]);
    const visibleMessages = allMessages.filter(message => message.visibility === 'ui');
    const projected = projectSensitiveAnswers(visibleMessages, toolInvocations, userInputRequests);
    const messages = projected.messages;
    const timeline = this.#timeline.build({
      messages,
      toolInvocations: projected.invocations,
      artifacts,
    });
    return {
      schemaVersion: 3,
      generatedAtMs: this.clock.nowMs(),
      session,
      jobs,
      plans,
      planSteps,
      messages,
      toolInvocations: projected.invocations,
      artifacts,
      userInputRequests: projected.requests,
      ...(modelUsage ? { modelUsage } : {}),
      timeline,
      cursor: {
        latestMessageRowId: messages.length > 0
          ? Math.max(...messages.map(message => message.rowId))
          : null,
      },
    };
  }
}

export function projectSensitiveAnswers(
  messages: AgentMessage[],
  invocations: AgentToolInvocation[],
  requests: AgentUserInputRequest[]
): { messages: AgentMessage[]; invocations: AgentToolInvocation[]; requests: AgentUserInputRequest[] } {
  const sensitive = requests.filter(isSensitiveAnswer);
  const answerMessageIds = new Set(sensitive.map(request => request.answerMessageId).filter(isString));
  const invocationIds = new Set(sensitive.map(request => request.toolInvocationId).filter(isString));
  return {
    messages: messages.map(message => answerMessageIds.has(message.id) ? redactAnswerMessage(message) : message),
    invocations: invocations.map(invocation => invocationIds.has(invocation.id) ? redactInvocationResult(invocation) : invocation),
    requests: requests.map(request => isSensitiveAnswer(request) ? redactRequestAnswer(request) : request),
  };
}

function isSensitiveAnswer(request: AgentUserInputRequest): boolean {
  return request.metadata?.sensitiveAnswer === true;
}

function redactRequestAnswer(request: AgentUserInputRequest): AgentUserInputRequest {
  const { answer: _answer, clientAnswerId: _clientAnswerId, ...safe } = request;
  return safe;
}

function redactAnswerMessage(message: AgentMessage): AgentMessage {
  const toolResult = message.toolResult
    ? { status: message.toolResult.status, durationMs: message.toolResult.durationMs }
    : undefined;
  return {
    ...message,
    content: '[Sensitive answer hidden]',
    ...(toolResult ? { toolResult } : {}),
  };
}

function redactInvocationResult(invocation: AgentToolInvocation): AgentToolInvocation {
  const { resultPayload: _resultPayload, ...safe } = invocation;
  return safe;
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}
