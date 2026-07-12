import type {
  AgentJob,
  AgentMessage,
  AgentPlan,
  AgentPlanStep,
  AgentStepRun,
} from '../../domain/index.js';
import { parseStepOutput, type StepOutputV1 } from '../../planner/step-output.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { resolveJobGoalMessage } from '../job-goal.js';
import { messagesInGroup, type MessageGroup } from '../context/message-group-builder.js';
import {
  SessionContextLoader,
  assertNoBlockedGroups,
  type SessionContextFacts,
} from './session-context-loader.js';

export type PlanContextStore = Pick<AgentStore,
  | 'getPlanByJobId'
  | 'listPlanSteps'
  | 'listJobStepRuns'
  | 'listSessionMessages'
  | 'listSessionToolInvocations'
>;

export interface PlanExecutionContext {
  job: AgentJob;
  originalGoal: string;
  originalGoalMessage: AgentMessage;
  plan: AgentPlan;
  steps: AgentPlanStep[];
  stepRuns: AgentStepRun[];
  sessionBaseline: MessageGroup[];
  currentPlanGroups: MessageGroup[];
  outputs: Array<{ stepId: string; output: StepOutputV1 }>;
  facts: SessionContextFacts;
}

export class PlanContextLoader {
  readonly #session: SessionContextLoader;

  constructor(private readonly store: PlanContextStore) {
    this.#session = new SessionContextLoader(store);
  }

  async load(job: AgentJob, originalGoal: string): Promise<PlanExecutionContext> {
    const [facts, plan, stepRuns] = await Promise.all([
      this.#session.load(job.sessionId),
      this.store.getPlanByJobId(job.id),
      this.store.listJobStepRuns(job.id),
    ]);
    if (!plan) throw new Error(`Planned Job ${job.id} has no Plan.`);
    const steps = await this.store.listPlanSteps(plan.id);
    const goalMessage = resolveJobGoalMessage(job, facts.messages);
    if (!goalMessage) throw new Error(`Job ${job.id} has no original user goal.`);
    assertNoBlockedGroups(facts.blocked, blocked => blocked.callMessage.jobId === job.id);
    const sessionBaseline = facts.groups.filter(group => (
      messagesInGroup(group).every(message => message.rowId <= goalMessage.rowId)
    ));
    const currentPlanGroups = facts.groups.filter(group => {
      const messages = messagesInGroup(group);
      return messages.some(message => (
        message.jobId === job.id && message.rowId > goalMessage.rowId
      )) && !messages.some(message => message.messageType === 'plan_created');
    });
    const messagesById = new Map(facts.messages.map(message => [message.id, message]));
    const outputs = steps.flatMap(step => {
      if (!step.outputMessageId) return [];
      const message = messagesById.get(step.outputMessageId);
      const structured = message?.metadata?.structuredOutput;
      if (!message || structured === undefined) {
        throw new Error(`PlanStep ${step.id} has no committed structured StepOutput.`);
      }
      return [{ stepId: step.id, output: parseStepOutput(structured) }];
    });
    return {
      job,
      originalGoal,
      originalGoalMessage: goalMessage,
      plan,
      steps: [...steps].sort((left, right) => left.position - right.position),
      stepRuns: [...stepRuns].sort((left, right) => (
        left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id)
      )),
      sessionBaseline,
      currentPlanGroups,
      outputs,
      facts,
    };
  }
}
