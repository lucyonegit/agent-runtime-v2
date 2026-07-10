import type {
  AgentExecutorKind,
  AgentInputRequest,
  AgentInputResumeMode,
  AgentInputSchema,
  AgentInputSource,
  AgentMessage,
  AgentMessageChannel,
  AgentMessageKind,
  AgentMessageRole,
  AgentMessageVisibility,
  AgentSession,
  AgentSessionMode,
  AgentTask,
  AgentTaskKind,
  AgentToolCall,
  AgentToolResult,
  AgentContextSnapshot,
  AgentContextScopeKind,
  AgentContextPurpose,
  AgentContextSnapshotKind,
  AgentContextSnapshotStatus,
  AgentContextBuild,
  AgentContextBuildStrategyValue,
  AgentContextUsageBreakdown,
  AgentModelCallPurpose,
  AgentModelCallResultType,
  AgentModelTokenUsage,
  AgentSessionTokenStats,
  AgentCodeProject,
  AgentCodeProjectStatus,
  AgentPlan,
  AgentPlanStatus,
  AgentPlanStep,
  AgentPlanStepStatus,
} from '../domain/index.js';

export interface CreateSessionInput {
  id: string;
  mode: AgentSessionMode;
  now: number;
  title?: string;
}

export interface CreateCodeProjectInput {
  id: string;
  sessionId: string;
  title: string;
  status?: AgentCodeProjectStatus;
  sandboxRelativePath: string;
  framework?: string;
  language?: string;
  packageManager?: string;
  currentInvariantsSnapshotId?: string;
  currentIndexSnapshotId?: string;
  metadata?: Record<string, unknown>;
  now: number;
}

export interface CreateTaskInput {
  id: string;
  sessionId: string;
  kind: AgentTaskKind;
  now: number;
  parentTaskId?: string;
  executor?: AgentExecutorKind;
  phase?: AgentTask['phase'];
  routeMode?: AgentTask['routeMode'];
  projectId?: string;
  executionId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface AppendMessageInput {
  id: string;
  sessionId: string;
  taskId: string;
  planId?: string;
  stepId?: string;
  outputId?: string;
  role: AgentMessageRole;
  content: string;
  createdAt: number;
  messageKind?: AgentMessageKind;
  visibility?: AgentMessageVisibility;
  channel?: AgentMessageChannel;
  toolCalls?: AgentToolCall[];
  toolResult?: AgentToolResult;
  metadata?: Record<string, unknown>;
}

export interface CreateInputRequestInput {
  id: string;
  sessionId: string;
  taskId: string;
  planId?: string;
  stepId?: string;
  source: AgentInputSource;
  toolCallMessageId?: string;
  resumeMode: AgentInputResumeMode;
  prompt: string;
  input: AgentInputSchema;
  now: number;
  toolCallId?: string;
  toolName?: string;
  title?: string;
}

export interface CreateContextSnapshotInput {
  id: string;
  sessionId: string;
  taskId?: string;
  scopeKind?: AgentContextScopeKind;
  scopeId?: string;
  purpose?: AgentContextPurpose;
  projectionVersion?: string;
  kind: AgentContextSnapshotKind;
  status: AgentContextSnapshotStatus;
  sourceRowIdStart: number;
  sourceRowIdEnd: number;
  baseSnapshotId?: string;
  supersedesSnapshotId?: string;
  summary: string;
  summaryFormat: 'markdown' | 'json';
  sourceMessageCount: number;
  sourceTokenCount?: number;
  summaryTokenCount?: number;
  model?: string;
  compressionPromptVersion: string;
  checksum?: string;
  metadata?: Record<string, unknown>;
  now: number;
}

export type ReplaceActiveContextSnapshotInput = Omit<CreateContextSnapshotInput, 'status'>;

export interface CreateContextBuildInput {
  id: string;
  sessionId: string;
  taskId: string;
  parentTaskId?: string;
  taskKind?: string;
  executor?: string;
  snapshotId?: string;
  executionId?: string;
  callKey?: string;
  projectionVersion?: string;
  model: string;
  callPurpose?: AgentModelCallPurpose;
  strategy: AgentContextBuildStrategyValue;
  maxContextTokens: number;
  reservedOutputTokens: number;
  estimatedInputTokens: number;
  includedRowIdStart?: number;
  includedRowIdEnd?: number;
  breakdown: AgentContextUsageBreakdown;
  contextManifest?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  now: number;
}

export interface CompleteContextBuildInput {
  usage?: AgentModelTokenUsage;
  outputId?: string;
  outputChannel?: string;
  resultType?: AgentModelCallResultType;
  toolCallCount?: number;
  toolNames?: string[];
  completedAt: number;
}

export interface CreatePlanInput {
  id: string;
  sessionId: string;
  rootTaskId: string;
  title: string;
  status?: AgentPlanStatus;
  metadata?: Record<string, unknown>;
  now: number;
}

export interface CreatePlanStepInput {
  id: string;
  planId: string;
  position: number;
  title: string;
  instruction: string;
  status?: AgentPlanStepStatus;
  taskId?: string;
  metadata?: Record<string, unknown>;
  now: number;
}

export interface AgentSessionStore {
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  getSession(sessionId: string): Promise<AgentSession | null>;
  listSessions(): Promise<AgentSession[]>;
  deleteSession(sessionId: string): Promise<AgentSession>;
  createCodeProject(input: CreateCodeProjectInput): Promise<AgentCodeProject>;
  getCodeProject(projectId: string): Promise<AgentCodeProject | null>;
  listCodeProjects(sessionId: string): Promise<AgentCodeProject[]>;
  deleteCodeProject(input: { sessionId: string; projectId: string }): Promise<AgentCodeProject>;
  createTask(input: CreateTaskInput): Promise<AgentTask>;
  updateTask(taskId: string, patch: Partial<AgentTask> & { updatedAt: number }): Promise<AgentTask>;
  appendMessage(input: AppendMessageInput): Promise<AgentMessage>;
  createInputRequest(input: CreateInputRequestInput): Promise<AgentInputRequest>;
  answerInputRequest(
    requestId: string,
    answer: NonNullable<AgentInputRequest['answer']>
  ): Promise<AgentInputRequest>;
  listTasks(sessionId: string): Promise<AgentTask[]>;
  listMessages(sessionId: string): Promise<AgentMessage[]>;
  listMessagesAfterRowId(sessionId: string, rowId: number): Promise<AgentMessage[]>;
  listInputRequests(sessionId: string): Promise<AgentInputRequest[]>;
  createPlan(input: CreatePlanInput): Promise<AgentPlan>;
  getPlan(planId: string): Promise<AgentPlan | null>;
  listPlans(sessionId: string): Promise<AgentPlan[]>;
  updatePlan(planId: string, patch: Partial<AgentPlan> & { updatedAt: number }): Promise<AgentPlan>;
  createPlanStep(input: CreatePlanStepInput): Promise<AgentPlanStep>;
  listPlanSteps(planId: string): Promise<AgentPlanStep[]>;
  updatePlanStep(planStepId: string, patch: Partial<AgentPlanStep> & { updatedAt: number }): Promise<AgentPlanStep>;
  getActiveContextSnapshot(sessionId: string): Promise<AgentContextSnapshot | null>;
  createContextSnapshot(input: CreateContextSnapshotInput): Promise<AgentContextSnapshot>;
  replaceActiveContextSnapshot(input: ReplaceActiveContextSnapshotInput): Promise<AgentContextSnapshot>;
  listContextSnapshots(sessionId: string): Promise<AgentContextSnapshot[]>;
  createContextBuild(input: CreateContextBuildInput): Promise<AgentContextBuild>;
  completeContextBuild(buildId: string, input: CompleteContextBuildInput): Promise<AgentContextBuild>;
  getSessionTokenStats(sessionId: string): Promise<AgentSessionTokenStats | null>;
  listContextBuilds(sessionId: string): Promise<AgentContextBuild[]>;
}
