import type {
  AgentJob,
  AgentJobError,
  AgentMessage,
  AgentSession,
  AgentSessionMode,
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
  | 'JOB_LEASE_LOST';

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

export interface AgentStore {
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  getSession(sessionId: string): Promise<AgentSession | undefined>;
  getJob(jobId: string): Promise<AgentJob | undefined>;
  getJobByClientRequestId(
    sessionId: string,
    clientRequestId: string
  ): Promise<AgentJob | undefined>;
  listSessionMessages(sessionId: string, afterRowId?: number): Promise<AgentMessage[]>;
  createJobAndAppendUserMessage(
    input: CreateJobAndAppendUserMessageInput
  ): Promise<CreateJobAndAppendUserMessageResult>;
  claimJob(input: ClaimJobInput): Promise<AgentJob>;
  renewJobLease(input: RenewJobLeaseInput): Promise<AgentJob>;
  failJob(input: FailJobInput): Promise<AgentJob>;
  cancelJob(input: CancelJobInput): Promise<AgentJob>;
}
