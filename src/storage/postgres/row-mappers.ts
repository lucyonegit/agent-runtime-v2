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
  AgentPlan,
  AgentPlanStatus,
  AgentPlanStep,
  AgentPlanStepStatus,
  AgentSession,
  AgentSessionMode,
  AgentSessionStatus,
  AgentStepRun,
  AgentStepRunExecutor,
  AgentStepRunStatus,
  AgentToolCall,
  AgentToolInvocation,
  AgentToolInvocationStatus,
  AgentToolResult,
  AgentToolSideEffectLevel,
  AgentUserInputAnswerMode,
  AgentUserInputRequest,
  AgentUserInputSchema,
  AgentUserInputSource,
  AgentUserInputStatus,
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

export interface AgentToolInvocationRow {
  id: string;
  session_id: string;
  job_id: string;
  plan_id: string | null;
  step_id: string | null;
  step_run_id: string | null;
  attempt_id: string;
  call_message_id: string;
  result_message_id: string | null;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  arguments_checksum: string;
  side_effect_level: string;
  idempotency_key: string;
  status: string;
  result_payload: unknown;
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
  version: number;
  metadata: unknown;
  created_at_ms: string | number;
  started_at_ms: string | number | null;
  completed_at_ms: string | number | null;
  updated_at_ms: string | number;
}

export interface AgentUserInputRequestRow {
  id: string;
  session_id: string;
  job_id: string;
  plan_id: string | null;
  step_id: string | null;
  step_run_id: string | null;
  tool_invocation_id: string | null;
  source: string;
  answer_mode: string;
  status: string;
  title: string | null;
  prompt: string;
  input_schema: unknown;
  answer: unknown;
  answer_message_id: string | null;
  client_answer_id: string | null;
  version: number;
  metadata: unknown;
  created_at_ms: string | number;
  updated_at_ms: string | number;
  answered_at_ms: string | number | null;
}

export interface AgentPlanRow {
  id: string;
  session_id: string;
  job_id: string;
  title: string;
  goal: string;
  status: string;
  version: number;
  metadata: unknown;
  created_at_ms: string | number;
  updated_at_ms: string | number;
  completed_at_ms: string | number | null;
}

export interface AgentPlanStepRow {
  id: string;
  plan_id: string;
  position: number;
  title: string;
  instruction: string;
  status: string;
  output_message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
  version: number;
  metadata: unknown;
  created_at_ms: string | number;
  updated_at_ms: string | number;
  completed_at_ms: string | number | null;
}

export interface AgentStepRunRow {
  id: string;
  session_id: string;
  job_id: string;
  plan_id: string;
  step_id: string;
  run_no: number;
  executor: string;
  status: string;
  current_attempt_id: string | null;
  attempt_no: number;
  output_message_id: string | null;
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

export function mapAgentToolInvocationRow(
  row: AgentToolInvocationRow
): AgentToolInvocation {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id,
    ...(row.plan_id === null ? {} : { planId: row.plan_id }),
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    ...(row.step_run_id === null ? {} : { stepRunId: row.step_run_id }),
    attemptId: row.attempt_id,
    callMessageId: row.call_message_id,
    ...(row.result_message_id === null ? {} : { resultMessageId: row.result_message_id }),
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    arguments: mapRecord(row.arguments, 'agent_tool_invocations.arguments'),
    argumentsChecksum: row.arguments_checksum,
    sideEffectLevel: row.side_effect_level as AgentToolSideEffectLevel,
    idempotencyKey: row.idempotency_key,
    status: row.status as AgentToolInvocationStatus,
    ...(row.result_payload === null ? {} : { resultPayload: row.result_payload }),
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
    ...(row.metadata === null
      ? {}
      : { metadata: mapRecord(row.metadata, 'agent_tool_invocations.metadata') }),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_tool_invocations.created_at_ms'),
    ...(row.started_at_ms === null
      ? {}
      : { startedAtMs: mapBigint(row.started_at_ms, 'agent_tool_invocations.started_at_ms') }),
    ...(row.completed_at_ms === null
      ? {}
      : { completedAtMs: mapBigint(row.completed_at_ms, 'agent_tool_invocations.completed_at_ms') }),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_tool_invocations.updated_at_ms'),
  };
}

export function mapAgentUserInputRequestRow(
  row: AgentUserInputRequestRow
): AgentUserInputRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id,
    ...(row.plan_id === null ? {} : { planId: row.plan_id }),
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    ...(row.step_run_id === null ? {} : { stepRunId: row.step_run_id }),
    ...(row.tool_invocation_id === null ? {} : { toolInvocationId: row.tool_invocation_id }),
    source: row.source as AgentUserInputSource,
    answerMode: row.answer_mode as AgentUserInputAnswerMode,
    status: row.status as AgentUserInputStatus,
    ...(row.title === null ? {} : { title: row.title }),
    prompt: row.prompt,
    inputSchema: mapRecord(row.input_schema, 'agent_user_input_requests.input_schema') as AgentUserInputSchema,
    ...(row.answer === null ? {} : { answer: row.answer }),
    ...(row.answer_message_id === null ? {} : { answerMessageId: row.answer_message_id }),
    ...(row.client_answer_id === null ? {} : { clientAnswerId: row.client_answer_id }),
    version: row.version,
    ...(row.metadata === null
      ? {}
      : { metadata: mapRecord(row.metadata, 'agent_user_input_requests.metadata') }),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_user_input_requests.created_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_user_input_requests.updated_at_ms'),
    ...(row.answered_at_ms === null
      ? {}
      : { answeredAtMs: mapBigint(row.answered_at_ms, 'agent_user_input_requests.answered_at_ms') }),
  };
}

export function mapAgentPlanRow(row: AgentPlanRow): AgentPlan {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id,
    title: row.title,
    goal: row.goal,
    status: row.status as AgentPlanStatus,
    version: row.version,
    ...(row.metadata === null ? {} : { metadata: mapRecord(row.metadata, 'agent_plans.metadata') }),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_plans.created_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_plans.updated_at_ms'),
    ...(row.completed_at_ms === null
      ? {}
      : { completedAtMs: mapBigint(row.completed_at_ms, 'agent_plans.completed_at_ms') }),
  };
}

export function mapAgentPlanStepRow(row: AgentPlanStepRow): AgentPlanStep {
  return {
    id: row.id,
    planId: row.plan_id,
    position: row.position,
    title: row.title,
    instruction: row.instruction,
    status: row.status as AgentPlanStepStatus,
    ...(row.output_message_id === null ? {} : { outputMessageId: row.output_message_id }),
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
    ...(row.metadata === null
      ? {}
      : { metadata: mapRecord(row.metadata, 'agent_plan_steps.metadata') }),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_plan_steps.created_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_plan_steps.updated_at_ms'),
    ...(row.completed_at_ms === null
      ? {}
      : { completedAtMs: mapBigint(row.completed_at_ms, 'agent_plan_steps.completed_at_ms') }),
  };
}

export function mapAgentStepRunRow(row: AgentStepRunRow): AgentStepRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id,
    planId: row.plan_id,
    stepId: row.step_id,
    runNo: row.run_no,
    executor: row.executor as AgentStepRunExecutor,
    status: row.status as AgentStepRunStatus,
    ...(row.current_attempt_id === null ? {} : { currentAttemptId: row.current_attempt_id }),
    attemptNo: row.attempt_no,
    ...(row.output_message_id === null ? {} : { outputMessageId: row.output_message_id }),
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
    ...(row.metadata === null
      ? {}
      : { metadata: mapRecord(row.metadata, 'agent_step_runs.metadata') }),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_step_runs.created_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_step_runs.updated_at_ms'),
    ...(row.started_at_ms === null
      ? {}
      : { startedAtMs: mapBigint(row.started_at_ms, 'agent_step_runs.started_at_ms') }),
    ...(row.completed_at_ms === null
      ? {}
      : { completedAtMs: mapBigint(row.completed_at_ms, 'agent_step_runs.completed_at_ms') }),
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
