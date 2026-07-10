import { AgentStoreError, type AgentStore } from '../storage/agent-store.js';
import { TimelineBuilder } from './timeline-builder.js';
import type { SessionViewV1 } from './view-contract.js';

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
      stepRuns,
      allMessages,
      toolInvocations,
      userInputRequests,
      modelUsage,
      codeProjects,
    ] = await Promise.all([
      this.store.listSessionJobs(sessionId),
      this.store.listSessionPlans(sessionId),
      this.store.listSessionPlanSteps(sessionId),
      this.store.listSessionStepRuns(sessionId),
      this.store.listSessionMessages(sessionId),
      this.store.listSessionToolInvocations(sessionId),
      this.store.listSessionUserInputRequests(sessionId),
      this.store.getModelUsageStats(sessionId),
      this.store.listSessionCodeProjects(sessionId),
    ]);
    const messages = allMessages.filter(message => message.visibility === 'ui');
    const timeline = this.#timeline.build({
      jobs,
      plans,
      planSteps,
      stepRuns,
      messages,
      toolInvocations,
      userInputRequests,
    });
    return {
      schemaVersion: 1,
      generatedAtMs: this.clock.nowMs(),
      session,
      jobs,
      plans,
      planSteps,
      stepRuns,
      messages,
      toolInvocations,
      userInputRequests,
      ...(modelUsage ? { modelUsage } : {}),
      codeProjects,
      timeline,
      cursor: {
        latestMessageRowId: messages.length > 0
          ? Math.max(...messages.map(message => message.rowId))
          : null,
      },
    };
  }
}
