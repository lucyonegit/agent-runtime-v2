import type {
  AgentJob,
  AgentMessage,
  AgentPlan,
  AgentPlanStep,
  AgentStepRun,
  AgentToolInvocation,
} from '../../domain/index.js';
import { parseStepOutput, type StepOutputV1 } from '../../planner/step-output.js';

export interface RuntimeRefs {
  sessionId: string;
  jobId: string;
  planId?: string;
  stepId?: string;
  stepRunId?: string;
}

export type MessageGroup =
  | { id: string; type: 'single'; messages: [AgentMessage] }
  | {
      id: string;
      type: 'tool_exchange';
      callMessage: AgentMessage;
      invocations: AgentToolInvocation[];
      resultMessages: AgentMessage[];
      refs: RuntimeRefs;
    }
  | {
      id: string;
      type: 'plan_definition';
      anchorMessage: AgentMessage;
      plan: AgentPlan;
      steps: AgentPlanStep[];
    }
  | {
      id: string;
      type: 'step_output';
      messages: [AgentMessage];
      message: AgentMessage;
      plan?: AgentPlan;
      step?: AgentPlanStep;
      stepRun?: AgentStepRun;
      output?: StepOutputV1;
    }
  | {
      id: string;
      type: 'plan_final';
      message: AgentMessage;
      plan: AgentPlan;
    };

export interface MessageGroupFacts {
  jobs: AgentJob[];
  plans: AgentPlan[];
  steps: AgentPlanStep[];
  stepRuns: AgentStepRun[];
}

export interface BlockedMessageGroup {
  callMessage: AgentMessage;
  reason:
    | 'missing_tool_calls'
    | 'missing_invocation'
    | 'invocation_not_terminal'
    | 'missing_result_message'
    | 'result_protocol_mismatch';
  toolCallId?: string;
}

export interface MessageGroupBuildResult {
  groups: MessageGroup[];
  blocked: BlockedMessageGroup[];
}

export class MessageGroupBuilder {
  build(
    messages: AgentMessage[],
    invocations: AgentToolInvocation[],
    facts?: MessageGroupFacts
  ): MessageGroupBuildResult {
    const orderedMessages = [...messages].sort((left, right) => left.rowId - right.rowId);
    const messagesById = new Map(orderedMessages.map(message => [message.id, message]));
    const invocationsByCallMessage = new Map<string, AgentToolInvocation[]>();
    for (const invocation of invocations) {
      const values = invocationsByCallMessage.get(invocation.callMessageId) ?? [];
      values.push(invocation);
      invocationsByCallMessage.set(invocation.callMessageId, values);
    }
    const consumedResultIds = new Set<string>();
    const planById = new Map(facts?.plans.map(plan => [plan.id, plan]) ?? []);
    const planByJobId = new Map(facts?.plans.map(plan => [plan.jobId, plan]) ?? []);
    const stepsByPlanId = new Map<string, AgentPlanStep[]>();
    for (const step of facts?.steps ?? []) {
      const values = stepsByPlanId.get(step.planId) ?? [];
      values.push(step);
      stepsByPlanId.set(step.planId, values);
    }
    const stepById = new Map(facts?.steps.map(step => [step.id, step]) ?? []);
    const stepRunById = new Map(facts?.stepRuns.map(run => [run.id, run]) ?? []);
    const groups: MessageGroup[] = [];
    const blocked: BlockedMessageGroup[] = [];

    for (const message of orderedMessages) {
      if (consumedResultIds.has(message.id) || message.messageType === 'tool_result') continue;
      if (message.messageType === 'plan_created') {
        const plan = (message.planId ? planById.get(message.planId) : undefined)
          ?? planByJobId.get(message.jobId);
        if (plan) {
          groups.push({
            id: `plan_definition:${plan.id}`,
            type: 'plan_definition',
            anchorMessage: message,
            plan,
            steps: [...(stepsByPlanId.get(plan.id) ?? [])].sort((left, right) => (
              left.position - right.position || left.id.localeCompare(right.id)
            )),
          });
          continue;
        }
      }
      if (message.messageType === 'step_output') {
        const step = message.stepId ? stepById.get(message.stepId) : undefined;
        const stepRun = message.stepRunId ? stepRunById.get(message.stepRunId) : undefined;
        const plan = (message.planId ? planById.get(message.planId) : undefined)
          ?? (step ? planById.get(step.planId) : undefined)
          ?? planByJobId.get(message.jobId);
        const structured = message.metadata?.structuredOutput;
        groups.push({
          id: `step_output:${message.id}`,
          type: 'step_output',
          messages: [message],
          message,
          ...(plan ? { plan } : {}),
          ...(step ? { step } : {}),
          ...(stepRun ? { stepRun } : {}),
          ...(structured === undefined ? {} : { output: parseStepOutput(structured) }),
        });
        continue;
      }
      if (message.messageType === 'plan_final') {
        const plan = (message.planId ? planById.get(message.planId) : undefined)
          ?? planByJobId.get(message.jobId);
        if (plan) {
          groups.push({
            id: `plan_final:${message.id}`,
            type: 'plan_final',
            message,
            plan,
          });
          continue;
        }
      }
      if (message.messageType !== 'tool_call') {
        groups.push({ id: `message:${message.id}`, type: 'single', messages: [message] });
        continue;
      }
      if (!message.toolCalls?.length) {
        blocked.push({ callMessage: message, reason: 'missing_tool_calls' });
        continue;
      }
      const candidates = invocationsByCallMessage.get(message.id) ?? [];
      const byToolCallId = new Map(candidates.map(invocation => [invocation.toolCallId, invocation]));
      const groupInvocations: AgentToolInvocation[] = [];
      const resultMessages: AgentMessage[] = [];
      let failure: BlockedMessageGroup | undefined;
      for (const toolCall of message.toolCalls) {
        const invocation = byToolCallId.get(toolCall.id);
        if (!invocation) {
          failure = { callMessage: message, reason: 'missing_invocation', toolCallId: toolCall.id };
          break;
        }
        if (!['completed', 'failed'].includes(invocation.status)) {
          failure = {
            callMessage: message,
            reason: 'invocation_not_terminal',
            toolCallId: toolCall.id,
          };
          break;
        }
        const resultMessage = invocation.resultMessageId
          ? messagesById.get(invocation.resultMessageId)
          : undefined;
        if (!resultMessage) {
          failure = {
            callMessage: message,
            reason: 'missing_result_message',
            toolCallId: toolCall.id,
          };
          break;
        }
        if (
          resultMessage.messageType !== 'tool_result'
          || resultMessage.toolCallId !== invocation.toolCallId
          || resultMessage.toolName !== invocation.toolName
        ) {
          failure = {
            callMessage: message,
            reason: 'result_protocol_mismatch',
            toolCallId: toolCall.id,
          };
          break;
        }
        groupInvocations.push(invocation);
        resultMessages.push(resultMessage);
      }
      if (failure) {
        blocked.push(failure);
        continue;
      }
      resultMessages.forEach(result => consumedResultIds.add(result.id));
      groups.push({
        id: `tool_exchange:${message.id}`,
        type: 'tool_exchange',
        callMessage: message,
        invocations: groupInvocations,
        resultMessages,
        refs: refsFor(message),
      });
    }
    return { groups, blocked };
  }
}

export function messagesInGroup(group: MessageGroup): AgentMessage[] {
  switch (group.type) {
    case 'tool_exchange':
      return [group.callMessage, ...group.resultMessages];
    case 'plan_definition':
      return [group.anchorMessage];
    case 'plan_final':
      return [group.message];
    case 'single':
    case 'step_output':
      return group.messages;
  }
}

function refsFor(message: AgentMessage): RuntimeRefs {
  return {
    sessionId: message.sessionId,
    jobId: message.jobId,
    ...(message.planId ? { planId: message.planId } : {}),
    ...(message.stepId ? { stepId: message.stepId } : {}),
    ...(message.stepRunId ? { stepRunId: message.stepRunId } : {}),
  };
}
