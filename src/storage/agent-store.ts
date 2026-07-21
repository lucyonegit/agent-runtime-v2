import type {
  AgentArtifact,
  AgentArtifactDraft,
  AgentJob,
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
  limit: number;
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

export interface AgentStore {
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  listSessions(): Promise<AgentSession[]>;
  deleteSession(sessionId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<AgentSession | undefined>;
  getJob(jobId: string): Promise<AgentJob | undefined>;
  getJobByClientRequestId(
    sessionId: string,
    clientRequestId: string
  ): Promise<AgentJob | undefined>;
  getToolInvocation(jobId: string, toolCallId: string): Promise<AgentToolInvocation | undefined>;
  getPlanByJobId(jobId: string): Promise<AgentPlan | undefined>;
  listPlanSteps(planId: string): Promise<AgentPlanStep[]>;
  getModelCall(modelCallId: string): Promise<AgentModelCall | undefined>;
  listModelCalls(jobId: string): Promise<AgentModelCall[]>;
  getModelUsageStats(sessionId: string): Promise<AgentModelUsageStats | undefined>;
  listActiveContextSummaries(
    ownerType: AgentContextOwnerType,
    ownerId: string,
    purpose: AgentContextPurpose,
    contextRulesVersion: string
  ): Promise<AgentContextSummary[]>;
  listSessionMessages(sessionId: string, afterRowId?: number): Promise<AgentMessage[]>;
  listSessionJobs(sessionId: string): Promise<AgentJob[]>;
  listSessionPlans(sessionId: string): Promise<AgentPlan[]>;
  listSessionPlanSteps(sessionId: string): Promise<AgentPlanStep[]>;
  listSessionToolInvocations(sessionId: string): Promise<AgentToolInvocation[]>;
  listSessionArtifacts(sessionId: string): Promise<AgentArtifact[]>;
  listSessionUserInputRequests(sessionId: string): Promise<AgentUserInputRequest[]>;
  listJobsNeedingRuntimeRecovery(input: ListJobsNeedingRuntimeRecoveryInput): Promise<AgentJob[]>;
  createJobAndAppendUserMessage(
    input: CreateJobAndAppendUserMessageInput
  ): Promise<CreateJobAndAppendUserMessageResult>;
  createRetryJob(input: CreateRetryJobInput): Promise<CreateRetryJobResult>;
  startJobExecution(input: StartJobExecutionInput): Promise<AgentJob>;
  renewJobExecutionLease(input: RenewJobExecutionLeaseInput): Promise<AgentJob>;
  commitModelToolCalls(input: CommitModelToolCallsInput): Promise<CommitModelToolCallsResult>;
  tryStartToolExecution(input: TryStartToolExecutionInput): Promise<TryStartToolExecutionResult>;
  commitToolResult(input: CommitToolResultInput): Promise<CommitToolResultResult>;
  completeJobWithFinalMessage(
    input: CompleteJobWithFinalMessageInput
  ): Promise<CompleteJobWithFinalMessageResult>;
  createInputRequestsAndMarkWaiting(
    input: CreateInputRequestsAndMarkWaitingInput
  ): Promise<CreateInputRequestsAndMarkWaitingResult>;
  saveUserInputAnswerAndResumeIfReady(
    input: SaveUserInputAnswerInput
  ): Promise<SaveUserInputAnswerResult>;
  applyPlanUpdate(input: ApplyPlanUpdateInput): Promise<ApplyPlanUpdateResult>;
  startModelCall(input: StartModelCallInput): Promise<AgentModelCall>;
  completeModelCall(input: CompleteModelCallInput): Promise<CompleteModelCallResult>;
  setModelCallOutputDisposition(
    input: SetModelCallOutputDispositionInput
  ): Promise<AgentModelCall>;
  abandonStartedModelCalls(nowMs: number): Promise<AgentModelCall[]>;
  replaceContextSummary(input: ReplaceContextSummaryInput): Promise<AgentContextSummary>;
  failJob(input: FailJobInput): Promise<AgentJob>;
  cancelJob(input: CancelJobInput): Promise<AgentJob>;
}
