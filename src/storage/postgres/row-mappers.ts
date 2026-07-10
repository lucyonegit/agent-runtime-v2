import type {
  AgentJob,
  AgentJobStage,
  AgentJobStatus,
  AgentJobStrategy,
  AgentMessage,
  AgentMessageChannel,
  AgentMessageRole,
  AgentMessageType,
  AgentMessageVisibility,
  AgentSession,
  AgentSessionMode,
  AgentSessionStatus,
  AgentToolCall,
  AgentToolResult,
} from '../../domain/index.js';

export interface AgentSessionRow {
  id: string;
  title: string | null;
  mode: string;
  status: string;
  version: number;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

export interface AgentJobRow {
  id: string;
  session_id: string;
  project_id: string | null;
  retry_of_job_id: string | null;
  client_request_id: string | null;
  strategy: string | null;
  stage: string;
  status: string;
  current_attempt_id: string | null;
  attempt_no: number;
  lease_owner: string | null;
  lease_expires_at_ms: string | number | null;
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
  version: number;
  metadata: unknown;
  created_at_ms: string | number;
  updated_at_ms: string | number;
  started_at_ms: string | number | null;
  completed_at_ms: string | number | null;
}

export interface AgentMessageRow {
  row_id: string | number;
  id: string;
  session_id: string;
  job_id: string;
  plan_id: string | null;
  step_id: string | null;
  step_run_id: string | null;
  attempt_id: string | null;
  output_id: string | null;
  role: string;
  message_type: string;
  visibility: string;
  channel: string | null;
  content: string;
  tool_calls: unknown;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_result: unknown;
  metadata: unknown;
  created_at_ms: string | number;
}

export function mapAgentSessionRow(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    ...(row.title === null ? {} : { title: row.title }),
    mode: row.mode as AgentSessionMode,
    status: row.status as AgentSessionStatus,
    version: row.version,
    createdAtMs: mapBigint(row.created_at_ms, 'agent_sessions.created_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_sessions.updated_at_ms'),
  };
}

export function mapAgentJobRow(row: AgentJobRow): AgentJob {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.retry_of_job_id === null ? {} : { retryOfJobId: row.retry_of_job_id }),
    ...(row.client_request_id === null ? {} : { clientRequestId: row.client_request_id }),
    ...(row.strategy === null ? {} : { strategy: row.strategy as AgentJobStrategy }),
    stage: row.stage as AgentJobStage,
    status: row.status as AgentJobStatus,
    ...(row.current_attempt_id === null ? {} : { currentAttemptId: row.current_attempt_id }),
    attemptNo: row.attempt_no,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at_ms === null
      ? {}
      : { leaseExpiresAtMs: mapBigint(row.lease_expires_at_ms, 'agent_jobs.lease_expires_at_ms') }),
    ...(row.error_code === null || row.error_message === null
      ? {}
      : {
          error: {
            code: row.error_code,
            message: row.error_message,
            ...(row.error_details === null ? {} : { details: row.error_details }),
          },
        }),
    version: row.version,
    ...(row.metadata === null ? {} : { metadata: mapRecord(row.metadata, 'agent_jobs.metadata') }),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_jobs.created_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_jobs.updated_at_ms'),
    ...(row.started_at_ms === null
      ? {}
      : { startedAtMs: mapBigint(row.started_at_ms, 'agent_jobs.started_at_ms') }),
    ...(row.completed_at_ms === null
      ? {}
      : { completedAtMs: mapBigint(row.completed_at_ms, 'agent_jobs.completed_at_ms') }),
  };
}

export function mapAgentMessageRow(row: AgentMessageRow): AgentMessage {
  return {
    rowId: mapBigint(row.row_id, 'agent_messages.row_id'),
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id,
    ...(row.plan_id === null ? {} : { planId: row.plan_id }),
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    ...(row.step_run_id === null ? {} : { stepRunId: row.step_run_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    ...(row.output_id === null ? {} : { outputId: row.output_id }),
    role: row.role as AgentMessageRole,
    messageType: row.message_type as AgentMessageType,
    visibility: row.visibility as AgentMessageVisibility,
    ...(row.channel === null ? {} : { channel: row.channel as AgentMessageChannel }),
    content: row.content,
    ...(row.tool_calls === null ? {} : { toolCalls: row.tool_calls as AgentToolCall[] }),
    ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
    ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
    ...(row.tool_result === null ? {} : { toolResult: row.tool_result as AgentToolResult }),
    ...(row.metadata === null ? {} : { metadata: mapRecord(row.metadata, 'agent_messages.metadata') }),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_messages.created_at_ms'),
  };
}

function mapBigint(value: string | number, field: string): number {
  const mapped = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(mapped)) {
    throw new RangeError(`${field} is outside the JavaScript safe integer range.`);
  }
  return mapped;
}

function mapRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}
