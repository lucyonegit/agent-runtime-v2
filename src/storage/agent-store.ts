import type {
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
  AgentModelUsageSource,
  AgentModelUsageStats,
  AgentPlan,
  AgentPlanStep,
  AgentSession,
  AgentStepRun,
  AgentToolCall,
  AgentToolInvocation,
  AgentToolSideEffectLevel,
  AgentUserInputAnswerMode,
  AgentUserInputRequest,
  AgentUserInputSchema,
  AgentUserInputSource,
} from '../domain/index.js';

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
  | 'STEP_RUN_NOT_FOUND'
  | 'INVALID_PLAN_STATE'
  | 'INVALID_STEP_RUN_STATE';

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

export interface ClaimJobInput {
  jobId: string;
  expectedVersion: number;
  workerId: string;
  attemptId: string;
  nowMs: number;
  leaseUntilMs: number;
}

export interface RenewJobLeaseInput extends ClaimJobInput {}

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

export interface PendingToolInvocationInput {
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
  stepRunId?: string;
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

export interface ClaimToolInvocationInput {
  jobId: string;
  toolCallId: string;
  workerId: string;
  attemptId: string;
  nowMs: number;
}

export interface ClaimToolInvocationResult {
  invocation: AgentToolInvocation;
  claimed: boolean;
}

export type CommittedToolOutcome =
  | { status: 'completed'; content: string; result?: unknown; durationMs: number }
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
  stepRunId?: string;
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
}

export interface CompleteJobWithFinalMessageInput {
  sessionId: string;
  jobId: string;
  attemptId: string;
  workerId: string;
  outputId: string;
  messageId: string;
  content: string;
  messageType?: 'assistant_message' | 'plan_final';
  nowMs: number;
}

export interface CompleteJobWithFinalMessageResult {
  job: AgentJob;
  message: AgentMessage;
}

export interface PendingUserInputRequestInput {
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
  stepRunId?: string;
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

export interface AnswerInputAndClaimResumeInput {
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

export interface AnswerInputAndClaimResumeResult {
  request: AgentUserInputRequest;
  answerMessage: AgentMessage;
  job: AgentJob;
  invocation?: AgentToolInvocation;
  shouldResume: boolean;
  attemptId?: string;
}

export interface RouteJobInput {
  jobId: string;
  workerId: string;
  attemptId: string;
  strategy: 'direct' | 'planned';
  nowMs: number;
}

export interface CreatePlanStepInput {
  id: string;
  title: string;
  instruction: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePlanInput {
  sessionId: string;
  jobId: string;
  workerId: string;
  attemptId: string;
  planId: string;
  messageId: string;
  title: string;
  goal: string;
  steps: CreatePlanStepInput[];
  metadata?: Record<string, unknown>;
  nowMs: number;
}

export interface CreatePlanResult {
  job: AgentJob;
  plan: AgentPlan;
  steps: AgentPlanStep[];
  message: AgentMessage;
}

export interface CreateStepRunInput {
  sessionId: string;
  jobId: string;
  workerId: string;
  attemptId: string;
  planId: string;
  stepId: string;
  stepRunId: string;
  maxRunsPerStep: number;
  nowMs: number;
}

export interface CreateStepRunResult {
  job: AgentJob;
  plan: AgentPlan;
  step: AgentPlanStep;
  stepRun: AgentStepRun;
}

export interface CommitStepOutputInput {
  sessionId: string;
  jobId: string;
  workerId: string;
  attemptId: string;
  stepRunId: string;
  messageId: string;
  outputId: string;
  content: string;
  structuredOutput: unknown;
  nowMs: number;
}

export interface CommitStepOutputResult {
  job: AgentJob;
  plan: AgentPlan;
  step: AgentPlanStep;
  stepRun: AgentStepRun;
  message: AgentMessage;
  hasPendingSteps: boolean;
}

export interface FailStepRunInput {
  sessionId: string;
  jobId: string;
  workerId: string;
  attemptId: string;
  stepRunId: string;
  error: AgentJobError;
  retryStep: boolean;
  nowMs: number;
}

export interface FailStepRunResult {
  job: AgentJob;
  plan: AgentPlan;
  step: AgentPlanStep;
  stepRun: AgentStepRun;
}

export interface StartModelCallInput {
  id: string;
  sessionId: string;
  jobId: string;
  stepRunId?: string;
  attemptId: string;
  workerId: string;
  logicalCallKey: string;
  callAttemptNo: number;
  callType: AgentModelCallType;
  provider: string;
  model: string;
  contextRulesVersion: string;
  inputManifest: AgentContextInputManifest;
  inputChecksum: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  estimatedInputTokens: number;
  metadata?: Record<string, unknown>;
  nowMs: number;
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
  stepRunId?: string;
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
  listJobStepRuns(jobId: string): Promise<AgentStepRun[]>;
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
  listSessionStepRuns(sessionId: string): Promise<AgentStepRun[]>;
  listSessionToolInvocations(sessionId: string): Promise<AgentToolInvocation[]>;
  listSessionUserInputRequests(sessionId: string): Promise<AgentUserInputRequest[]>;
  createJobAndAppendUserMessage(
    input: CreateJobAndAppendUserMessageInput
  ): Promise<CreateJobAndAppendUserMessageResult>;
  createRetryJob(input: CreateRetryJobInput): Promise<CreateRetryJobResult>;
  claimJob(input: ClaimJobInput): Promise<AgentJob>;
  renewJobLease(input: RenewJobLeaseInput): Promise<AgentJob>;
  commitModelToolCalls(input: CommitModelToolCallsInput): Promise<CommitModelToolCallsResult>;
  claimToolInvocation(input: ClaimToolInvocationInput): Promise<ClaimToolInvocationResult>;
  commitToolResult(input: CommitToolResultInput): Promise<CommitToolResultResult>;
  completeJobWithFinalMessage(
    input: CompleteJobWithFinalMessageInput
  ): Promise<CompleteJobWithFinalMessageResult>;
  createInputRequestsAndMarkWaiting(
    input: CreateInputRequestsAndMarkWaitingInput
  ): Promise<CreateInputRequestsAndMarkWaitingResult>;
  answerInputAndClaimResume(
    input: AnswerInputAndClaimResumeInput
  ): Promise<AnswerInputAndClaimResumeResult>;
  routeJob(input: RouteJobInput): Promise<AgentJob>;
  createPlan(input: CreatePlanInput): Promise<CreatePlanResult>;
  createStepRun(input: CreateStepRunInput): Promise<CreateStepRunResult>;
  commitStepOutput(input: CommitStepOutputInput): Promise<CommitStepOutputResult>;
  failStepRun(input: FailStepRunInput): Promise<FailStepRunResult>;
  startModelCall(input: StartModelCallInput): Promise<AgentModelCall>;
  completeModelCall(input: CompleteModelCallInput): Promise<CompleteModelCallResult>;
  abandonStartedModelCalls(nowMs: number): Promise<AgentModelCall[]>;
  replaceContextSummary(input: ReplaceContextSummaryInput): Promise<AgentContextSummary>;
  failJob(input: FailJobInput): Promise<AgentJob>;
  cancelJob(input: CancelJobInput): Promise<AgentJob>;
}
