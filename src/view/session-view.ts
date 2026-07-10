import type {
  AgentInputRequest,
  AgentCodeProject,
  AgentMessage,
  AgentSession,
  AgentSessionTokenStats,
  AgentTask,
} from '../domain/index.js';
import type { AgentSessionStore } from '../storage/index.js';

export interface AgentSessionView {
  session: AgentSession;
  tasks: AgentTask[];
  messages: AgentMessage[];
  groupedTimeline: AgentTimelineItem[];
  inputRequests: AgentInputRequest[];
  codeProjects: AgentCodeProject[];
  tokenStats?: AgentSessionTokenStats;
}

export type AgentTimelineItem =
  | {
      type: 'message';
      message: AgentMessage;
    }
  | AgentPlanTimelineItem;

export interface AgentPlanTimelineItem {
  type: 'plan';
  message: AgentMessage;
  planId: string;
  title: string;
  steps: AgentPlanTimelineStep[];
}

export interface AgentPlanTimelineStep {
  stepId: string;
  taskId?: string;
  title: string;
  instruction?: string;
  status: AgentTask['status'] | 'pending';
  items: AgentStepTimelineItem[];
}

export type AgentStepTimelineItem =
  | {
      type: 'message';
      message: AgentMessage;
    }
  | {
      type: 'tool_call';
      message: AgentMessage;
      call: NonNullable<AgentMessage['toolCalls']>[number];
      resultMessage?: AgentMessage;
      result?: AgentMessage['toolResult'];
    }
  | {
      type: 'tool_result';
      message: AgentMessage;
      result: NonNullable<AgentMessage['toolResult']>;
    };

export async function loadSessionView(
  store: AgentSessionStore,
  sessionId: string
): Promise<AgentSessionView> {
  const session = await store.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const [tasks, messages, inputRequests, codeProjects, tokenStats] = await Promise.all([
    store.listTasks(sessionId),
    store.listMessages(sessionId),
    store.listInputRequests(sessionId),
    store.listCodeProjects(sessionId),
    store.getSessionTokenStats(sessionId),
  ]);

  return {
    session,
    tasks,
    messages: messages.filter(isUiVisibleMessage),
    groupedTimeline: buildGroupedTimeline(messages.filter(isUiVisibleMessage), tasks),
    inputRequests,
    codeProjects,
    tokenStats: tokenStats ?? undefined,
  };
}

function isUiVisibleMessage(message: AgentMessage): boolean {
  if (message.visibility === 'internal') {
    return false;
  }
  if (message.messageKind === 'system_prompt' || message.messageKind === 'planner_step_input') {
    return false;
  }
  if (message.metadata?.visibility === 'internal') {
    return false;
  }
  if (message.metadata?.kind === 'system_prompt' || message.metadata?.kind === 'planner_step_input') {
    return false;
  }
  return message.role !== 'system';
}

export function buildGroupedTimeline(messages: AgentMessage[], tasks: AgentTask[]): AgentTimelineItem[] {
  const orderedMessages = [...messages].sort(compareMessages);
  const planItems = compactPlanMessages(orderedMessages)
    .map(message => createPlanTimelineItem(message, orderedMessages, tasks))
    .filter((item): item is AgentPlanTimelineItem => Boolean(item));
  const planItemsByMessageId = new Map(planItems.map(item => [item.message.id, item]));
  const planMessageIds = new Set(
    orderedMessages
      .filter(message => Boolean(getPlan(message)))
      .map(message => message.id)
  );
  const consumedMessageIds = new Set<string>();

  for (const planItem of planItems) {
    for (const step of planItem.steps) {
      for (const item of step.items) {
        consumedMessageIds.add(item.message.id);
        if (item.type === 'tool_call' && item.resultMessage) {
          consumedMessageIds.add(item.resultMessage.id);
        }
      }
    }
  }

  return orderedMessages.flatMap((message): AgentTimelineItem[] => {
    const planItem = planItemsByMessageId.get(message.id);
    if (planItem) {
      return [planItem];
    }
    if (planMessageIds.has(message.id)) {
      return [];
    }
    if (consumedMessageIds.has(message.id)) {
      return [];
    }
    return [{ type: 'message', message }];
  });
}

function createPlanTimelineItem(
  message: AgentMessage,
  messages: AgentMessage[],
  tasks: AgentTask[]
): AgentPlanTimelineItem | undefined {
  const plan = getPlan(message);
  if (!plan) {
    return undefined;
  }

  const stepTasksByStepId = new Map(
    tasks
      .filter(task => task.kind === 'planner_step' && typeof task.metadata?.stepId === 'string')
      .map(task => [String(task.metadata?.stepId), task])
  );

  return {
    type: 'plan',
    message,
    planId: plan.id,
    title: plan.title,
    steps: plan.steps.map((step, index) => {
      const stepId = step.id || `step_${index + 1}`;
      const task = stepTasksByStepId.get(stepId);
      return {
        stepId,
        taskId: task?.id,
        title: step.title || `Step ${index + 1}`,
        instruction: step.instruction,
        status: task?.status ?? normalizeStepStatus(step.status) ?? 'pending',
        items: buildStepTimelineItems(messages, stepId, task?.id),
      };
    }),
  };
}

function buildStepTimelineItems(
  messages: AgentMessage[],
  stepId: string,
  taskId?: string
): AgentStepTimelineItem[] {
  const stepMessages = messages
    .filter(message => isStepMessage(message, stepId, taskId))
    .sort(compareMessages);
  const toolResultsByCallId = new Map<string, AgentMessage>();

  for (const message of stepMessages) {
    if (message.toolResult) {
      toolResultsByCallId.set(message.toolResult.toolCallId, message);
    }
  }

  const consumedToolResultIds = new Set<string>();
  const items: AgentStepTimelineItem[] = [];
  for (const message of stepMessages) {
    if (message.toolCalls?.length) {
      if (message.content.trim()) {
        items.push({ type: 'message', message });
      }
      for (const call of message.toolCalls) {
        const resultMessage = toolResultsByCallId.get(call.id);
        if (resultMessage) {
          consumedToolResultIds.add(resultMessage.id);
        }
        items.push({
          type: 'tool_call',
          message,
          call,
          resultMessage,
          result: resultMessage?.toolResult,
        });
      }
      continue;
    }

    if (message.toolResult) {
      if (!consumedToolResultIds.has(message.id)) {
        items.push({ type: 'tool_result', message, result: message.toolResult });
      }
      continue;
    }

    items.push({ type: 'message', message });
  }
  return items;
}

function isStepMessage(message: AgentMessage, stepId: string, taskId?: string): boolean {
  return message.taskId === taskId || message.metadata?.stepId === stepId;
}

function getPlan(message: AgentMessage): {
  id: string;
  title: string;
  steps: Array<{ id?: string; title?: string; instruction?: string; status?: unknown }>;
} | undefined {
  if (message.messageKind !== 'plan' && message.messageKind !== 'plan_update' && message.metadata?.kind !== 'plan' && message.metadata?.kind !== 'plan_update') {
    return undefined;
  }
  const plan = message.metadata?.plan;
  if (!isRecord(plan) || typeof plan.title !== 'string' || !Array.isArray(plan.steps)) {
    return undefined;
  }
  const id = typeof plan.id === 'string'
    ? plan.id
    : typeof message.metadata?.planId === 'string'
      ? message.metadata.planId
      : message.id;
  return {
    id,
    title: plan.title,
    steps: plan.steps.filter(isRecord).map(step => ({
      id: typeof step.id === 'string' ? step.id : undefined,
      title: typeof step.title === 'string' ? step.title : undefined,
      instruction: typeof step.instruction === 'string' ? step.instruction : undefined,
      status: step.status,
    })),
  };
}

function compactPlanMessages(messages: AgentMessage[]): AgentMessage[] {
  const firstByPlanId = new Map<string, AgentMessage>();
  const latestByPlanId = new Map<string, AgentMessage>();
  for (const message of messages) {
    const plan = getPlan(message);
    if (!plan) {
      continue;
    }
    if (!firstByPlanId.has(plan.id)) {
      firstByPlanId.set(plan.id, message);
    }
    latestByPlanId.set(plan.id, message);
  }

  return [...latestByPlanId.entries()].map(([planId, latest]) => {
    const first = firstByPlanId.get(planId) ?? latest;
    return {
      ...latest,
      id: first.id,
      rowId: first.rowId,
      createdAt: first.createdAt,
    };
  });
}

function compareMessages(left: AgentMessage, right: AgentMessage): number {
  if (left.rowId !== right.rowId) {
    return left.rowId - right.rowId;
  }
  return left.createdAt - right.createdAt;
}

function normalizeStepStatus(value: unknown): AgentTask['status'] | 'pending' | undefined {
  if (
    value === 'created'
    || value === 'running'
    || value === 'waiting_user_input'
    || value === 'resuming'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'pending'
  ) {
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
