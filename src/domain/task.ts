export type AgentTaskStatus =
  | 'created'
  | 'running'
  | 'waiting_user_input'
  | 'resuming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentTaskKind = 'react' | 'planner' | 'planner_step' | 'code';
export type AgentExecutorKind = 'react' | 'planner' | 'code';
export type AgentTaskPhase = 'routing' | 'planning' | 'executing' | 'finalizing';
export type AgentTaskRouteMode = 'direct' | 'planned';

export interface AgentTask {
  id: string;
  sessionId: string;
  parentTaskId?: string;
  kind: AgentTaskKind;
  executor?: AgentExecutorKind;
  phase?: AgentTaskPhase;
  routeMode?: AgentTaskRouteMode;
  projectId?: string;
  executionId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  status: AgentTaskStatus;
  waitingRequestId?: string;
  waitingRequestIds?: string[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  version: number;
  error?: {
    message: string;
    details?: unknown;
    failedAt: number;
  };
  metadata?: Record<string, unknown>;
}

export function createTask(input: {
  id: string;
  sessionId: string;
  kind: AgentTaskKind;
  now: number;
  parentTaskId?: string;
  executor?: AgentExecutorKind;
  phase?: AgentTaskPhase;
  routeMode?: AgentTaskRouteMode;
  projectId?: string;
  executionId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  metadata?: Record<string, unknown>;
}): AgentTask {
  return {
    id: input.id,
    sessionId: input.sessionId,
    parentTaskId: input.parentTaskId,
    kind: input.kind,
    executor: input.executor,
    phase: input.phase,
    routeMode: input.routeMode,
    projectId: input.projectId
      ?? (typeof input.metadata?.projectId === 'string' ? input.metadata.projectId : undefined),
    executionId: input.executionId,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: input.leaseExpiresAt,
    status: 'created',
    createdAt: input.now,
    updatedAt: input.now,
    version: 0,
    metadata: input.metadata,
  };
}

export function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

const allowedTransitions: Record<AgentTaskStatus, AgentTaskStatus[]> = {
  created: ['running', 'cancelled'],
  running: ['waiting_user_input', 'completed', 'failed', 'cancelled'],
  waiting_user_input: ['resuming', 'cancelled'],
  resuming: ['running', 'failed', 'cancelled'],
  failed: ['resuming', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function transitionTaskStatus(
  task: AgentTask,
  nextStatus: AgentTaskStatus,
  options: {
    now: number;
    waitingRequestId?: string;
    waitingRequestIds?: string[];
    error?: AgentTask['error'];
  }
): AgentTask {
  if (isTerminalTaskStatus(task.status)) {
    throw new Error(`Cannot transition terminal task ${task.id} from ${task.status}`);
  }

  if (!allowedTransitions[task.status].includes(nextStatus)) {
    throw new Error(`Invalid task status transition from ${task.status} to ${nextStatus}`);
  }

  const waitingRequestIds = options.waitingRequestIds
    ?? (options.waitingRequestId ? [options.waitingRequestId] : undefined);

  return {
    ...task,
    status: nextStatus,
    updatedAt: options.now,
    startedAt: task.startedAt ?? (nextStatus === 'running' ? options.now : undefined),
    completedAt: nextStatus === 'completed' || nextStatus === 'cancelled'
      ? options.now
      : task.completedAt,
    version: task.version,
    waitingRequestId: nextStatus === 'waiting_user_input' ? waitingRequestIds?.[0] : undefined,
    waitingRequestIds: nextStatus === 'waiting_user_input' ? waitingRequestIds : undefined,
    error: nextStatus === 'failed'
      ? options.error ?? { message: 'Task failed', failedAt: options.now }
      : task.error,
  };
}
