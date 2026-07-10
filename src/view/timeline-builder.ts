import type {
  AgentJob,
  AgentMessage,
  AgentPlan,
  AgentPlanStep,
  AgentStepRun,
  AgentToolInvocation,
  AgentUserInputRequest,
} from '../domain/index.js';
import type {
  FlatTimelineItem,
  JobTimelineGroup,
  StepTimelineGroup,
} from './view-contract.js';

export interface TimelineBuilderInput {
  jobs: AgentJob[];
  plans: AgentPlan[];
  planSteps: AgentPlanStep[];
  stepRuns: AgentStepRun[];
  messages: AgentMessage[];
  toolInvocations: AgentToolInvocation[];
  userInputRequests: AgentUserInputRequest[];
}

export class TimelineBuilder {
  build(input: TimelineBuilderInput): {
    flat: FlatTimelineItem[];
    groupedByStep: JobTimelineGroup[];
  } {
    const flat = buildFlat(input.messages, input.toolInvocations);
    const plansByJob = new Map(input.plans.map(plan => [plan.jobId, plan]));
    const stepsByPlan = groupBy(input.planSteps, step => step.planId);
    const runsByStep = groupBy(input.stepRuns, run => run.stepId);
    const directItemsByJob = groupBy(
      flat.filter(item => itemStepRunId(item) === undefined),
      item => itemJobId(item)
    );
    const itemsByRun = groupBy(
      flat.filter(item => itemStepRunId(item) !== undefined),
      item => itemStepRunId(item)!
    );
    const groupedByStep = [...input.jobs]
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id))
      .map<JobTimelineGroup>(job => {
        const items: Array<FlatTimelineItem | StepTimelineGroup> = [
          ...(directItemsByJob.get(job.id) ?? []),
        ];
        const plan = plansByJob.get(job.id);
        for (const step of [...(plan ? stepsByPlan.get(plan.id) ?? [] : [])]
          .sort((left, right) => left.position - right.position)) {
          const runs = [...(runsByStep.get(step.id) ?? [])]
            .sort((left, right) => left.runNo - right.runNo);
          if (runs.length === 0) {
            items.push({
              type: 'step_group',
              jobId: job.id,
              plan,
              step,
              status: step.status,
              items: [],
            });
          }
          for (const run of runs) {
            items.push({
              type: 'step_group',
              jobId: job.id,
              plan,
              step,
              stepRun: run,
              status: run.status,
              items: itemsByRun.get(run.id) ?? [],
            });
          }
        }
        return { type: 'job_group', job, items };
      });
    return { flat, groupedByStep };
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
  for (const status of ['unknown', 'waiting_user_input', 'running', 'pending', 'failed', 'cancelled'] as const) {
    if (statuses.has(status)) return status;
  }
  return 'completed';
}

function itemJobId(item: FlatTimelineItem): string {
  return item.type === 'message' ? item.message.jobId : item.callMessage.jobId;
}

function itemStepRunId(item: FlatTimelineItem): string | undefined {
  return item.type === 'message' ? item.message.stepRunId : item.callMessage.stepRunId;
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
