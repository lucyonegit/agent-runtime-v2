import type {
  AgentArtifact,
  AgentArtifactDraft,
  AgentJob,
  AgentLoopCheckpoint,
  AgentContextInputManifest,
  AgentContextOwnerType,
  AgentContextPurpose,
  AgentContextSummary,
  AgentContextSummaryType,
  AgentJobError,
  AgentMessage,
  AgentModelCall,
  AgentModelCallType,
  AgentModelOutputDisposition,
  AgentModelUsageSource,
  AgentModelUsageStats,
  AgentPlan,
  AgentPlanStep,
  AgentSession,
  AgentToolCall,
  AgentToolInvocation,
  AgentToolSideEffectLevel,
  AgentUserInputAnswerMode,
  AgentUserInputRequest,
  AgentUserInputSchema,
  AgentUserInputSource,
} from '../domain/index.js';
import type { StoredMessage } from '@langchain/core/messages';

export type AgentStoreErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_EXISTS'
  | 'JOB_NOT_FOUND'
  | 'JOB_ALREADY_EXISTS'
  | 'ACTIVE_JOB_CONFLICT'
  | 'CLIENT_REQUEST_CONFLICT'
  | 'CONCURRENCY_CONFLICT'
  | 'INVALID_JOB_STATE'
  | 'INVALID_JOB_RETRY'
  | 'JOB_LEASE_LOST'
  | 'TOOL_INVOCATION_NOT_FOUND'
  | 'TOOL_INVOCATION_CONFLICT'
  | 'INVALID_TOOL_INVOCATION_STATE'
  | 'USER_INPUT_REQUEST_NOT_FOUND'
  | 'INVALID_USER_INPUT_STATE'
  | 'USER_INPUT_ANSWER_CONFLICT'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_STEP_NOT_FOUND'
  | 'INVALID_PLAN_STATE';

export class AgentStoreError extends Error {
  readonly code: AgentStoreErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AgentStoreErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentStoreError';
    this.code = code;
    this.details = details;
  }
}

export interface CreateSessionInput {
  id: string;
  title?: string;
  nowMs: number;
}

export interface CreateJobAndAppendUserMessageInput {
  sessionId: string;
  jobId: string;
  userMessageId: string;
  content: string;
  retryOfJobId?: string;
  clientRequestId?: string;
  jobMetadata?: Record<string, unknown>;
  messageMetadata?: Record<string, unknown>;
  nowMs: number;
}

export interface CreateJobAndAppendUserMessageResult {
  session: AgentSession;
  job: AgentJob;
  message: AgentMessage;
}

export interface CreateRetryJobInput {
  sessionId: string;
  jobId: string;
  retryOfJobId: string;
  clientRequestId?: string;
  jobMetadata?: Record<string, unknown>;
  nowMs: number;
}

export interface CreateRetryJobResult {
  session: AgentSession;
  job: AgentJob;
}

export interface StartJobExecutionInput {
  jobId: string;
  expectedVersion: number;
  workerId: string;
  attemptId: string;
  nowMs: number;
  leaseUntilMs: number;
}

export interface ListJobsNeedingRuntimeRecoveryInput {
  nowMs: number;
  createdBeforeMs: number;
  limit: number;
}

export interface MarkJobRecoveryRequiredInput {
  jobId: string;
  expectedVersion: number;
  nowMs: number;
}

export interface RenewJobExecutionLeaseInput extends StartJobExecutionInput {}

export interface FailJobInput {
  jobId: string;
  expectedVersion: number;
  workerId: string;
  attemptId: string;
  error: AgentJobError;
  nowMs: number;
}

export interface CancelJobInput {
  jobId: string;
  expectedVersion: number;
  nowMs: number;
}

interface PendingToolInvocationInput {
  invocationId: string;
  call: AgentToolCall;
  argumentsChecksum: string;
  sideEffectLevel: AgentToolSideEffectLevel;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface CommitModelToolCallsInput {
  sessionId: string;
  jobId: string;
  attemptId: string;
  workerId: string;
  outputId: string;
  messageId: string;
  content: string;
  invocations: PendingToolInvocationInput[];
  nowMs: number;
}

export interface CommitModelToolCallsResult {
  message: AgentMessage;
  invocations: AgentToolInvocation[];
}

export interface TryStartToolExecutionInput {
  jobId: string;
  toolCallId: string;
  workerId: string;
  attemptId: string;
  nowMs: number;
}

export interface TryStartToolExecutionResult {
  invocation: AgentToolInvocation;
  started: boolean;
}

export interface PrepareToolInvocationsForRecoveryInput {
  jobId: string;
  workerId: string;
  attemptId: string;
  nowMs: number;
}

export interface PrepareToolInvocationsForRecoveryResult {
  checkpoint?: AgentLoopCheckpoint;
  invocations: AgentToolInvocation[];
  blockedInvocations: AgentToolInvocation[];
}

type CommittedToolOutcome =
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

export interface CommitToolResultInput {
  sessionId: string;
  jobId: string;
  attemptId: string;
  workerId: string;
  toolCallId: string;
  messageId: string;
  outcome: CommittedToolOutcome;
  nowMs: number;
}

export interface CommitToolResultResult {
  message: AgentMessage;
  invocation: AgentToolInvocation;
  artifacts: AgentArtifact[];
}

export interface CompleteJobWithFinalMessageInput {
  sessionId: string;
  jobId: string;
  attemptId: string;
  workerId: string;
  outputId: string;
  messageId: string;
  content: string;
  nowMs: number;
}

export interface CompleteJobWithFinalMessageResult {
  job: AgentJob;
  message: AgentMessage;
}

interface PendingUserInputRequestInput {
  requestId: string;
  toolCallId?: string;
  source: AgentUserInputSource;
  answerMode: AgentUserInputAnswerMode;
  title?: string;
  prompt: string;
  inputSchema: AgentUserInputSchema;
  metadata?: Record<string, unknown>;
}

export interface CreateInputRequestsAndMarkWaitingInput {
  sessionId: string;
  jobId: string;
  attemptId: string;
  workerId: string;
  requests: PendingUserInputRequestInput[];
  nowMs: number;
}

export interface CreateInputRequestsAndMarkWaitingResult {
  job: AgentJob;
  requests: AgentUserInputRequest[];
  invocations: AgentToolInvocation[];
}

export interface SaveUserInputAnswerInput {
  requestId: string;
  expectedVersion: number;
  clientAnswerId: string;
  answer: unknown;
  answerMessageId: string;
  workerId: string;
  attemptId: string;
  nowMs: number;
  leaseUntilMs: number;
}

export interface SaveUserInputAnswerResult {
  request: AgentUserInputRequest;
  answerMessage: AgentMessage;
  job: AgentJob;
  invocation?: AgentToolInvocation;
  shouldResume: boolean;
  attemptId?: string;
}

interface ApplyPlanStepInput {
  id: string;
  key: string;
  position: number;
  title: string;
  description?: string;
  status: AgentPlanStep['status'];
  result?: AgentPlanStep['result'];
  error?: AgentJobError;
  metadata?: Record<string, unknown>;
}

export interface ApplyPlanUpdateInput {
  sessionId: string;
  jobId: string;
  workerId: string;
  attemptId: string;
  planId: string;
  expectedVersion: number;
  title: string;
  goal: string;
  steps: ApplyPlanStepInput[];
  metadata?: Record<string, unknown>;
  nowMs: number;
}

export interface ApplyPlanUpdateResult {
  plan: AgentPlan;
  steps: AgentPlanStep[];
}

export interface StartModelCallInput {
  id: string;
  sessionId: string;
  jobId: string;
  attemptId: string;
  workerId: string;
  logicalCallKey: string;
  callAttemptNo: number;
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
  jobId: string;
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

export interface ReplaceContextSummaryInput {
  id: string;
  sessionId: string;
  jobId?: string;
  ownerType: AgentContextOwnerType;
  ownerId: string;
  purpose: AgentContextPurpose;
  contextRulesVersion: string;
  summaryType: AgentContextSummaryType;
  sourceRowIdStart: number;
  sourceRowIdEnd: number;
  parentSummaryId?: string;
  summary: string;
  summaryFormat: 'markdown' | 'json';
  sourceMessageCount: number;
  sourceTokenCount?: number;
  summaryTokenCount?: number;
  model?: string;
  compressionPromptVersion: string;
  checksum: string;
  metadata?: Record<string, unknown>;
  nowMs: number;
}

/** Session aggregate queries and lifecycle commands. */
export interface SessionStore {
  create(input: CreateSessionInput): Promise<AgentSession>;
  list(): Promise<AgentSession[]>;
  delete(sessionId: string): Promise<boolean>;
  get(sessionId: string): Promise<AgentSession | undefined>;
  listMessages(sessionId: string, afterRowId?: number): Promise<AgentMessage[]>;
  listJobs(sessionId: string): Promise<AgentJob[]>;
  listPlans(sessionId: string): Promise<AgentPlan[]>;
  listPlanSteps(sessionId: string): Promise<AgentPlanStep[]>;
  listToolInvocations(sessionId: string): Promise<AgentToolInvocation[]>;
  listArtifacts(sessionId: string): Promise<AgentArtifact[]>;
  listUserInputRequests(sessionId: string): Promise<AgentUserInputRequest[]>;
}

/** Durable Job lifecycle commands. Cross-table commands remain atomic. */
export interface JobStore {
  get(jobId: string): Promise<AgentJob | undefined>;
  getByClientRequestId(
    sessionId: string,
    clientRequestId: string
  ): Promise<AgentJob | undefined>;
  listNeedingRecovery(input: ListJobsNeedingRuntimeRecoveryInput): Promise<AgentJob[]>;
  markRecoveryRequired(input: MarkJobRecoveryRequiredInput): Promise<AgentJob>;
  createWithUserMessage(
    input: CreateJobAndAppendUserMessageInput
  ): Promise<CreateJobAndAppendUserMessageResult>;
  createRetry(input: CreateRetryJobInput): Promise<CreateRetryJobResult>;
  startExecution(input: StartJobExecutionInput): Promise<AgentJob>;
  renewExecutionOwnership(input: RenewJobExecutionLeaseInput): Promise<AgentJob>;
  fail(input: FailJobInput): Promise<AgentJob>;
  cancel(input: CancelJobInput): Promise<AgentJob>;
}

/** ReAct checkpoint, tool and HITL persistence. */
export interface ExecutionStore {
  getToolInvocation(jobId: string, toolCallId: string): Promise<AgentToolInvocation | undefined>;
  getLatestLoopCheckpoint(jobId: string): Promise<AgentLoopCheckpoint | undefined>;
  commitModelToolCalls(input: CommitModelToolCallsInput): Promise<CommitModelToolCallsResult>;
  tryStartTool(input: TryStartToolExecutionInput): Promise<TryStartToolExecutionResult>;
  prepareToolsForRecovery(
    input: PrepareToolInvocationsForRecoveryInput
  ): Promise<PrepareToolInvocationsForRecoveryResult>;
  commitToolResult(input: CommitToolResultInput): Promise<CommitToolResultResult>;
  completeWithFinalMessage(
    input: CompleteJobWithFinalMessageInput
  ): Promise<CompleteJobWithFinalMessageResult>;
  waitForUserInput(
    input: CreateInputRequestsAndMarkWaitingInput
  ): Promise<CreateInputRequestsAndMarkWaitingResult>;
  answerUserInput(
    input: SaveUserInputAnswerInput
  ): Promise<SaveUserInputAnswerResult>;
}

/** Plan projection and update commands. */
export interface PlanStore {
  getByJobId(jobId: string): Promise<AgentPlan | undefined>;
  listSteps(planId: string): Promise<AgentPlanStep[]>;
  applyUpdate(input: ApplyPlanUpdateInput): Promise<ApplyPlanUpdateResult>;
}

/** Model-call audit and token-usage persistence. */
export interface ModelStore {
  getCall(modelCallId: string): Promise<AgentModelCall | undefined>;
  listCalls(jobId: string): Promise<AgentModelCall[]>;
  listRecentSessionCalls(sessionId: string, limit: number): Promise<AgentModelCall[]>;
  getUsageStats(sessionId: string): Promise<AgentModelUsageStats | undefined>;
  startCall(input: StartModelCallInput): Promise<AgentModelCall>;
  completeCall(input: CompleteModelCallInput): Promise<CompleteModelCallResult>;
  setCallOutputDisposition(
    input: SetModelCallOutputDispositionInput
  ): Promise<AgentModelCall>;
  abandonStartedCalls(nowMs: number): Promise<AgentModelCall[]>;
}

/** Context-summary queries and replacement command. */
export interface ContextStore {
  listActiveSummaries(
    ownerType: AgentContextOwnerType,
    ownerId: string,
    purpose: AgentContextPurpose,
    contextRulesVersion: string
  ): Promise<AgentContextSummary[]>;
  getSummariesByIds(ids: string[]): Promise<AgentContextSummary[]>;
  replaceSummary(input: ReplaceContextSummaryInput): Promise<AgentContextSummary>;
}

/**
 * The single persistence root used by Runtime and Orchestration.
 *
 * Each property exposes one cohesive storage capability. Callers can now read
 * `store.jobs.startExecution()` or `store.models.completeCall()` without
 * searching a flat list of unrelated database operations.
 */
export interface AgentStore {
  readonly sessions: SessionStore;
  readonly jobs: JobStore;
  readonly execution: ExecutionStore;
  readonly plans: PlanStore;
  readonly models: ModelStore;
  readonly context: ContextStore;
}
