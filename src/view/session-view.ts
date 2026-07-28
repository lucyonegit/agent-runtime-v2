import { AgentStoreError, type AgentStore } from '../storage/agent-store.js';
import { TimelineBuilder } from './timeline-builder.js';
import type { SessionViewV1 } from './view-contract.js';
import type {
  AgentManagedProcess,
  AgentMessage,
  AgentToolInvocation,
  AgentUserInputRequest,
} from '../domain/index.js';

export interface SessionProcessReader {
  listSessionProcesses(sessionId: string): Promise<AgentManagedProcess[]>;
}

export class SessionView {
  readonly #timeline = new TimelineBuilder();

  constructor(
    private readonly store: AgentStore,
    private readonly clock: { nowMs(): number } = { nowMs: () => Date.now() },
    private readonly processReader?: SessionProcessReader
  ) {}

  async load(sessionId: string): Promise<SessionViewV1> {
    const session = await this.store.sessions.get(sessionId);
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
      managedProcesses,
      userInputRequests,
      modelUsage,
    ] = await Promise.all([
      this.store.sessions.listJobs(sessionId),
      this.store.sessions.listPlans(sessionId),
      this.store.sessions.listPlanSteps(sessionId),
      this.store.sessions.listMessages(sessionId),
      this.store.sessions.listToolInvocations(sessionId),
      this.store.sessions.listArtifacts(sessionId),
      this.processReader?.listSessionProcesses(sessionId) ?? Promise.resolve([]),
      this.store.sessions.listUserInputRequests(sessionId),
      this.store.models.getUsageStats(sessionId),
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
      schemaVersion: 4,
      generatedAtMs: this.clock.nowMs(),
      session,
      jobs,
      plans,
      planSteps,
      messages,
      toolInvocations: projected.invocations,
      artifacts,
      managedProcesses,
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
