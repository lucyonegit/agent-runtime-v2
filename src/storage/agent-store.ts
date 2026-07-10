import type {
  AgentJob,
  AgentJobError,
  AgentMessage,
  AgentSession,
  AgentSessionMode,
  AgentToolCall,
  AgentToolInvocation,
  AgentToolSideEffectLevel,
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
  | 'INVALID_TOOL_INVOCATION_STATE';

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
  mode: AgentSessionMode;
  nowMs: number;
}

export interface CreateJobAndAppendUserMessageInput {
  sessionId: string;
  jobId: string;
  userMessageId: string;
  content: string;
  projectId?: string;
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
  | { status: 'failed'; code: string; message: string; details?: unknown; durationMs: number };

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

export interface AgentStore {
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  getSession(sessionId: string): Promise<AgentSession | undefined>;
  getJob(jobId: string): Promise<AgentJob | undefined>;
  getJobByClientRequestId(
    sessionId: string,
    clientRequestId: string
  ): Promise<AgentJob | undefined>;
  getToolInvocation(jobId: string, toolCallId: string): Promise<AgentToolInvocation | undefined>;
  listSessionMessages(sessionId: string, afterRowId?: number): Promise<AgentMessage[]>;
  createJobAndAppendUserMessage(
    input: CreateJobAndAppendUserMessageInput
  ): Promise<CreateJobAndAppendUserMessageResult>;
  claimJob(input: ClaimJobInput): Promise<AgentJob>;
  renewJobLease(input: RenewJobLeaseInput): Promise<AgentJob>;
  commitModelToolCalls(input: CommitModelToolCallsInput): Promise<CommitModelToolCallsResult>;
  claimToolInvocation(input: ClaimToolInvocationInput): Promise<ClaimToolInvocationResult>;
  commitToolResult(input: CommitToolResultInput): Promise<CommitToolResultResult>;
  failJob(input: FailJobInput): Promise<AgentJob>;
  cancelJob(input: CancelJobInput): Promise<AgentJob>;
}
