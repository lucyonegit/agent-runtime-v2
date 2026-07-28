import type { StoredMessage } from '@langchain/core/messages';
import type {
  AgentActivePlan,
  AgentArtifact,
  AgentArtifactDraft,
  AgentContextInputManifest,
  AgentContextCompaction,
  AgentExecutionError,
  AgentMessage,
  AgentMessageToolCall,
  AgentModelCall,
  AgentModelCallType,
  AgentModelOutputDisposition,
  AgentModelUsageSource,
  AgentModelUsageStats,
  AgentPlanStep,
  AgentSession,
  AgentTask,
  AgentTaskCheckpoint,
  AgentTaskRun,
  AgentTaskRunTrigger,
  AgentToolCall,
  AgentToolRun,
  AgentToolSideEffectLevel,
  AgentUserInputRequest,
  AgentUserInputSchema,
} from '../domain/index.js';

export type AgentStoreErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_EXISTS'
  | 'INVALID_SESSION_STATE'
  | 'TASK_NOT_FOUND'
  | 'TASK_ALREADY_EXISTS'
  | 'ACTIVE_TASK_CONFLICT'
  | 'CLIENT_REQUEST_CONFLICT'
  | 'CONCURRENCY_CONFLICT'
  | 'INVALID_TASK_STATE'
  | 'INVALID_TASK_RETRY'
  | 'TASK_RUN_NOT_FOUND'
  | 'TASK_OWNERSHIP_LOST'
  | 'TOOL_CALL_NOT_FOUND'
  | 'TOOL_CALL_CONFLICT'
  | 'INVALID_TOOL_CALL_STATE'
  | 'USER_INPUT_REQUEST_NOT_FOUND'
  | 'INVALID_USER_INPUT_STATE'
  | 'USER_INPUT_ANSWER_CONFLICT'
  | 'ACTIVE_PLAN_NOT_FOUND';

export class AgentStoreError extends Error {
  constructor(
    readonly code: AgentStoreErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentStoreError';
  }
}

export interface CreateSessionInput {
  id: string;
  title?: string;
  nowMs: number;
}

export interface BeginSessionDeletionInput {
  sessionId: string;
  nowMs: number;
}

export interface BeginSessionDeletionResult {
  existed: boolean;
  taskFinishes: FinishTaskResult[];
}

export interface CreateTaskWithUserMessageInput {
  sessionId: string;
  taskId: string;
  userMessageId: string;
  content: string;
  retryOfTaskId?: string;
  clientRequestId?: string;
  taskMetadata?: Record<string, unknown>;
  messageMetadata?: Record<string, unknown>;
  nowMs: number;
}

export interface CreateTaskWithUserMessageResult {
  session: AgentSession;
  task: AgentTask;
  message: AgentMessage;
}

export interface CreateRetryTaskInput {
  sessionId: string;
  taskId: string;
  retryOfTaskId: string;
  clientRequestId?: string;
  taskMetadata?: Record<string, unknown>;
  nowMs: number;
}

export interface CreateRetryTaskResult {
  session: AgentSession;
  task: AgentTask;
}

export interface StartTaskRunInput {
  taskId: string;
  expectedTaskVersion: number;
  taskRunId: string;
  trigger: AgentTaskRunTrigger;
  ownerId: string;
  nowMs: number;
  ownershipExpiresAtMs: number;
}

export interface StartTaskRunResult {
  task: AgentTask;
  taskRun: AgentTaskRun;
}

export interface RenewTaskRunOwnershipInput {
  taskId: string;
  taskRunId: string;
  ownerId: string;
  nowMs: number;
  ownershipExpiresAtMs: number;
}

export interface ListTasksNeedingRecoveryInput {
  nowMs: number;
  createdBeforeMs: number;
  limit: number;
}

export interface TaskRecoveryCandidate {
  task: AgentTask;
  taskRun?: AgentTaskRun;
}

export interface MarkTaskRecoveryRequiredInput {
  taskId: string;
  expectedTaskVersion: number;
  nowMs: number;
}

export interface MarkTaskRecoveryRequiredResult {
  task: AgentTask;
  taskRun?: AgentTaskRun;
  toolCalls: AgentToolCall[];
  toolRuns: AgentToolRun[];
}

export interface FailTaskInput {
  taskId: string;
  expectedTaskVersion: number;
  taskRunId: string;
  ownerId: string;
  error: AgentExecutionError;
  nowMs: number;
}

export interface FinishTaskResult {
  task: AgentTask;
  taskRun?: AgentTaskRun;
  toolCalls: AgentToolCall[];
  toolRuns: AgentToolRun[];
  userInputRequests: AgentUserInputRequest[];
  checkpoint?: AgentTaskCheckpoint;
  planCleared: boolean;
}

export interface CancelTaskInput {
  taskId: string;
  expectedTaskVersion: number;
  nowMs: number;
}

interface PendingToolCallInput {
  id: string;
  call: AgentMessageToolCall;
  argumentsChecksum: string;
  sideEffectLevel: AgentToolSideEffectLevel;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface SaveToolCallsInput {
  sessionId: string;
  taskId: string;
  taskRunId: string;
  ownerId: string;
  outputId: string;
  messageId: string;
  content: string;
  toolCalls: PendingToolCallInput[];
  contextScope: 'conversation' | 'task';
  nowMs: number;
}

export interface SaveToolCallsResult {
  message: AgentMessage;
  toolCalls: AgentToolCall[];
}

export interface StartToolRunInput {
  taskId: string;
  taskRunId: string;
  modelToolCallId: string;
  toolRunId: string;
  workerId: string;
  nowMs: number;
}

export interface StartToolRunResult {
  toolCall: AgentToolCall;
  toolRun?: AgentToolRun;
  started: boolean;
}

export interface PrepareToolCallsForResumeInput {
  taskId: string;
  taskRunId: string;
  ownerId: string;
  nowMs: number;
}

export interface PrepareToolCallsForResumeResult {
  checkpoint?: AgentTaskCheckpoint;
  toolCalls: AgentToolCall[];
  blockedToolCalls: AgentToolCall[];
}

type CompletedToolOutcome =
  | {
      status: 'completed';
      content: string;
      result?: unknown;
      artifacts?: Array<AgentArtifactDraft & { id: string }>;
      durationMs: number;
    }
  | {
      status: 'failed';
      executionStarted?: boolean;
      code: string;
      message: string;
      details?: unknown;
      durationMs: number;
    };

export interface CompleteToolCallInput {
  sessionId: string;
  taskId: string;
  taskRunId: string;
  ownerId: string;
  modelToolCallId: string;
  messageId: string;
  outcome: CompletedToolOutcome;
  nowMs: number;
}

export interface CompleteToolCallResult {
  message: AgentMessage;
  toolCall: AgentToolCall;
  toolRun: AgentToolRun;
  artifacts: AgentArtifact[];
  recoveryRequired?: {
    task: AgentTask;
    taskRun: AgentTaskRun;
  };
}

export interface CompleteTaskWithFinalMessageInput {
  sessionId: string;
  taskId: string;
  taskRunId: string;
  ownerId: string;
  outputId: string;
  messageId: string;
  content: string;
  nowMs: number;
}

export interface CompleteTaskWithFinalMessageResult extends FinishTaskResult {
  message: AgentMessage;
}

interface PendingUserInputRequestInput {
  requestId: string;
  modelToolCallId: string;
  title?: string;
  prompt: string;
  inputSchema: AgentUserInputSchema;
  expiresAtMs?: number;
  metadata?: Record<string, unknown>;
}

export interface WaitForUserInputInput {
  sessionId: string;
  taskId: string;
  taskRunId: string;
  ownerId: string;
  requests: PendingUserInputRequestInput[];
  nowMs: number;
}

export interface WaitForUserInputResult {
  task: AgentTask;
  taskRun: AgentTaskRun;
  requests: AgentUserInputRequest[];
  toolCalls: AgentToolCall[];
  toolRuns: AgentToolRun[];
}

export interface SaveUserInputAnswerInput {
  requestId: string;
  expectedVersion: number;
  clientAnswerId: string;
  answer: unknown;
  answerMessageId: string;
  taskRunId: string;
  ownerId: string;
  nowMs: number;
  ownershipExpiresAtMs: number;
}

export interface SaveUserInputAnswerResult {
  request: AgentUserInputRequest;
  answerMessage: AgentMessage;
  task: AgentTask;
  taskRun?: AgentTaskRun;
  toolCall: AgentToolCall;
  shouldResume: boolean;
}

export interface ExpireUserInputRequestInput {
  requestId: string;
  expectedVersion: number;
  resultMessageId: string;
  taskRunId: string;
  ownerId: string;
  nowMs: number;
  ownershipExpiresAtMs: number;
}

export interface ExpireUserInputRequestResult {
  request: AgentUserInputRequest;
  resultMessage: AgentMessage;
  task: AgentTask;
  taskRun?: AgentTaskRun;
  toolCall: AgentToolCall;
  shouldResume: boolean;
}

export interface ApplyActivePlanInput {
  sessionId: string;
  taskId: string;
  taskRunId: string;
  ownerId: string;
  title: string;
  steps: AgentPlanStep[];
  nowMs: number;
}

export interface StartModelCallInput {
  id: string;
  sessionId: string;
  taskId: string;
  taskRunId: string;
  ownerId: string;
  logicalCallKey: string;
  callType: AgentModelCallType;
  provider: string;
  model: string;
  contextRulesVersion: string;
  inputManifest: AgentContextInputManifest;
  inputMessages: StoredMessage[];
  inputChecksum: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  estimatedInputTokens: number;
  outputId?: string;
  metadata?: Record<string, unknown>;
  nowMs: number;
}

export interface SetModelCallOutputDispositionInput {
  taskId: string;
  outputId: string;
  disposition: Exclude<AgentModelOutputDisposition, 'pending'>;
  reason?: string;
}

export interface CompleteModelCallInput {
  id: string;
  status: 'completed' | 'failed' | 'cancelled';
  usageSource: AgentModelUsageSource;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualTotalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputId?: string;
  resultType?: string;
  resultPayload?: unknown;
  toolNames?: string[];
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: unknown;
  nowMs: number;
}

export interface CompleteModelCallResult {
  call: AgentModelCall;
  usage: AgentModelUsageStats;
}

export interface ReplaceContextCompactionInput {
  sessionId: string;
  throughMessageRowId: number;
  summary: string;
  nowMs: number;
}

export interface AgentSessionSnapshot {
  session: AgentSession;
  tasks: AgentTask[];
  taskRuns: AgentTaskRun[];
  activePlan?: AgentActivePlan;
  messages: AgentMessage[];
  toolCalls: AgentToolCall[];
  toolRuns: AgentToolRun[];
  artifacts: AgentArtifact[];
  userInputRequests: AgentUserInputRequest[];
  modelUsage?: AgentModelUsageStats;
}

export interface AgentContextSnapshot {
  messages: AgentMessage[];
  activePlan?: AgentActivePlan;
  compaction?: AgentContextCompaction;
}

export interface SessionStore {
  create(input: CreateSessionInput): Promise<AgentSession>;
  list(): Promise<AgentSession[]>;
  beginDeletion(input: BeginSessionDeletionInput): Promise<BeginSessionDeletionResult>;
  finalizeDeletion(sessionId: string): Promise<boolean>;
  loadSnapshot(sessionId: string): Promise<AgentSessionSnapshot>;
  get(sessionId: string): Promise<AgentSession | undefined>;
  listMessages(sessionId: string, afterRowId?: number): Promise<AgentMessage[]>;
  listTasks(sessionId: string): Promise<AgentTask[]>;
  listTaskRuns(sessionId: string): Promise<AgentTaskRun[]>;
  listToolCalls(sessionId: string): Promise<AgentToolCall[]>;
  listToolRuns(sessionId: string): Promise<AgentToolRun[]>;
  listArtifacts(sessionId: string): Promise<AgentArtifact[]>;
  listUserInputRequests(sessionId: string): Promise<AgentUserInputRequest[]>;
}

export interface TaskStore {
  get(taskId: string): Promise<AgentTask | undefined>;
  getByClientRequestId(sessionId: string, clientRequestId: string): Promise<AgentTask | undefined>;
  getLatestRun(taskId: string): Promise<AgentTaskRun | undefined>;
  listNeedingRecovery(input: ListTasksNeedingRecoveryInput): Promise<TaskRecoveryCandidate[]>;
  createWithUserMessage(input: CreateTaskWithUserMessageInput): Promise<CreateTaskWithUserMessageResult>;
  createRetry(input: CreateRetryTaskInput): Promise<CreateRetryTaskResult>;
  startRun(input: StartTaskRunInput): Promise<StartTaskRunResult>;
  renewRunOwnership(input: RenewTaskRunOwnershipInput): Promise<AgentTaskRun>;
  markRecoveryRequired(input: MarkTaskRecoveryRequiredInput): Promise<MarkTaskRecoveryRequiredResult>;
  fail(input: FailTaskInput): Promise<FinishTaskResult>;
  cancel(input: CancelTaskInput): Promise<FinishTaskResult>;
}

export interface ExecutionStore {
  getToolCall(taskId: string, modelToolCallId: string): Promise<AgentToolCall | undefined>;
  getLatestCheckpoint(taskId: string): Promise<AgentTaskCheckpoint | undefined>;
  saveToolCalls(input: SaveToolCallsInput): Promise<SaveToolCallsResult>;
  startToolRun(input: StartToolRunInput): Promise<StartToolRunResult>;
  prepareToolCallsForResume(input: PrepareToolCallsForResumeInput): Promise<PrepareToolCallsForResumeResult>;
  completeToolCall(input: CompleteToolCallInput): Promise<CompleteToolCallResult>;
  completeTask(input: CompleteTaskWithFinalMessageInput): Promise<CompleteTaskWithFinalMessageResult>;
  waitForUserInput(input: WaitForUserInputInput): Promise<WaitForUserInputResult>;
  answerUserInput(input: SaveUserInputAnswerInput): Promise<SaveUserInputAnswerResult>;
  listExpiredUserInputRequests(nowMs: number, limit: number): Promise<AgentUserInputRequest[]>;
  expireUserInput(input: ExpireUserInputRequestInput): Promise<ExpireUserInputRequestResult>;
}

export interface PlanStore {
  getActive(sessionId: string): Promise<AgentActivePlan | undefined>;
  apply(input: ApplyActivePlanInput): Promise<AgentActivePlan>;
  clear(sessionId: string, taskId: string): Promise<boolean>;
}

export interface ModelStore {
  getCall(modelCallId: string): Promise<AgentModelCall | undefined>;
  listCalls(taskId: string): Promise<AgentModelCall[]>;
  listRecentSessionCalls(sessionId: string, limit: number): Promise<AgentModelCall[]>;
  getUsageStats(sessionId: string): Promise<AgentModelUsageStats | undefined>;
  startCall(input: StartModelCallInput): Promise<AgentModelCall>;
  completeCall(input: CompleteModelCallInput): Promise<CompleteModelCallResult>;
  setCallOutputDisposition(input: SetModelCallOutputDispositionInput): Promise<AgentModelCall>;
  abandonStartedCalls(nowMs: number): Promise<AgentModelCall[]>;
}

export interface ContextStore {
  loadInputSnapshot(sessionId: string): Promise<AgentContextSnapshot>;
  getCompaction(sessionId: string): Promise<AgentContextCompaction | undefined>;
  replaceCompaction(input: ReplaceContextCompactionInput): Promise<AgentContextCompaction>;
}

export interface AgentStore {
  readonly sessions: SessionStore;
  readonly tasks: TaskStore;
  readonly execution: ExecutionStore;
  readonly plans: PlanStore;
  readonly models: ModelStore;
  readonly context: ContextStore;
}
