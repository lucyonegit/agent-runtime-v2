import type {
  AgentManagedProcess,
  AgentMessage,
  AgentToolCall,
  AgentUserInputRequest,
} from '../domain/index.js';
import { ACTIVE_TASK_STATUSES } from '../domain/index.js';
import { AgentStoreError, type AgentStore } from '../storage/agent-store.js';
import { TimelineBuilder } from './timeline-builder.js';
import type { AgentSessionView } from './view-contract.js';

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

  async load(sessionId: string): Promise<AgentSessionView> {
    const session = await this.store.sessions.get(sessionId);
    if (!session) {
      throw new AgentStoreError(
        'SESSION_NOT_FOUND',
        `Agent session ${JSON.stringify(sessionId)} was not found.`
      );
    }
    const [
      tasks,
      taskRuns,
      activePlan,
      allMessages,
      toolCalls,
      toolRuns,
      artifacts,
      managedProcesses,
      userInputRequests,
      modelUsage,
    ] = await Promise.all([
      this.store.sessions.listTasks(sessionId),
      this.store.sessions.listTaskRuns(sessionId),
      this.store.plans.getActive(sessionId),
      this.store.sessions.listMessages(sessionId),
      this.store.sessions.listToolCalls(sessionId),
      this.store.sessions.listToolRuns(sessionId),
      this.store.sessions.listArtifacts(sessionId),
      this.processReader?.listSessionProcesses(sessionId) ?? Promise.resolve([]),
      this.store.sessions.listUserInputRequests(sessionId),
      this.store.models.getUsageStats(sessionId),
    ]);
    const visibleMessages = allMessages.filter(message => message.visibility === 'ui');
    const projected = projectSensitiveAnswers(visibleMessages, toolCalls, userInputRequests);
    const timeline = this.#timeline.build({
      messages: projected.messages,
      toolCalls: projected.toolCalls,
      artifacts,
    });
    const activeStatuses = new Set<string>(ACTIVE_TASK_STATUSES);
    const activeTask = tasks.find(task => activeStatuses.has(task.status));
    return {
      schemaVersion: 5,
      generatedAtMs: this.clock.nowMs(),
      session,
      tasks,
      ...(activeTask ? { activeTask } : {}),
      taskRuns,
      ...(activePlan ? { activePlan } : {}),
      messages: projected.messages,
      toolCalls: projected.toolCalls,
      toolRuns,
      artifacts,
      managedProcesses,
      userInputRequests: projected.requests,
      ...(modelUsage ? { modelUsage } : {}),
      timeline,
      cursor: {
        latestMessageRowId: projected.messages.length > 0
          ? Math.max(...projected.messages.map(message => message.rowId))
          : null,
      },
    };
  }
}

export function projectSensitiveAnswers(
  messages: AgentMessage[],
  toolCalls: AgentToolCall[],
  requests: AgentUserInputRequest[]
): { messages: AgentMessage[]; toolCalls: AgentToolCall[]; requests: AgentUserInputRequest[] } {
  const sensitiveAnswerMessageIds = new Set(
    requests
      .filter(request => request.metadata?.sensitiveAnswer === true)
      .map(request => request.answerMessageId)
      .filter((id): id is string => typeof id === 'string')
  );
  return {
    messages: messages.map(message => sensitiveAnswerMessageIds.has(message.id)
      ? redactAnswerMessage(message)
      : message),
    toolCalls,
    requests: requests.map(request => request.metadata?.sensitiveAnswer === true
      ? redactRequestAnswer(request)
      : request),
  };
}

function redactRequestAnswer(request: AgentUserInputRequest): AgentUserInputRequest {
  const { clientAnswerId: _clientAnswerId, ...safe } = request;
  return safe;
}

function redactAnswerMessage(message: AgentMessage): AgentMessage {
  return {
    ...message,
    content: '[Sensitive answer hidden]',
    ...(message.toolResult ? {
      toolResult: {
        status: message.toolResult.status,
        durationMs: message.toolResult.durationMs,
      },
    } : {}),
  };
}
