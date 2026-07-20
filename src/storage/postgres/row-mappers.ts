import type {
  AgentJob,
  AgentJobStatus,
  AgentContextSummary,
  AgentContextOwnerType,
  AgentContextPurpose,
  AgentContextSummaryStatus,
  AgentContextSummaryType,
  AgentContextInputManifest,
  AgentMessage,
  AgentMessageChannel,
  AgentMessageRole,
  AgentMessageType,
  AgentMessageVisibility,
  AgentModelCall,
  AgentModelCallStatus,
  AgentModelCallType,
  AgentModelUsageSource,
  AgentModelUsageStats,
  AgentPlan,
  AgentPlanStatus,
  AgentPlanStep,
  AgentPlanStepStatus,
  AgentSession,
  AgentSessionStatus,
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
import type { StoredMessage } from '@langchain/core/messages';

export interface AgentSessionRow {
  id: string;
  title: string | null;
  status: string;
  version: number;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

export interface AgentJobRow {
  id: string;
  session_id: string;
  retry_of_job_id: string | null;
  client_request_id: string | null;
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
  plan_step_id: string | null;
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
  plan_step_id: string | null;
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
  plan_step_id: string | null;
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
  key: string;
  position: number;
  title: string;
  description: string | null;
  status: string;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
  version: number;
  metadata: unknown;
  created_at_ms: string | number;
  updated_at_ms: string | number;
  completed_at_ms: string | number | null;
}

export interface AgentContextSummaryRow {
  id: string;
  session_id: string;
  job_id: string | null;
  owner_type: string;
  owner_id: string;
  purpose: string;
  context_rules_version: string;
  summary_type: string;
  status: string;
  source_row_id_start: string | number;
  source_row_id_end: string | number;
  parent_summary_id: string | null;
  replaces_summary_id: string | null;
  summary: string;
  summary_format: string;
  source_message_count: number;
  source_token_count: number | null;
  summary_token_count: number | null;
  model: string | null;
  compression_prompt_version: string;
  checksum: string;
  version: number;
  metadata: unknown;
  created_at_ms: string | number;
  updated_at_ms: string | number;
}

export interface AgentModelCallRow {
  id: string;
  session_id: string;
  job_id: string;
  attempt_id: string;
  logical_call_key: string;
  call_attempt_no: number;
  call_type: string;
  status: string;
  provider: string;
  model: string;
  context_rules_version: string;
  input_manifest: unknown;
  input_messages: unknown;
  input_checksum: string;
  max_context_tokens: number;
  reserved_output_tokens: number;
  estimated_input_tokens: number;
  actual_input_tokens: number | null;
  actual_output_tokens: number | null;
  actual_total_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  usage_source: string;
  output_id: string | null;
  result_type: string | null;
  result_payload: unknown;
  tool_names: unknown;
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
  metadata: unknown;
  created_at_ms: string | number;
  completed_at_ms: string | number | null;
}

export interface AgentModelUsageStatsRow {
  session_id: string;
  total_model_calls: number;
  total_estimated_input_tokens: string | number;
  total_actual_input_tokens: string | number;
  total_actual_output_tokens: string | number;
  total_cache_read_input_tokens: string | number;
  total_cache_write_input_tokens: string | number;
  total_tokens: string | number;
  latest_model_call_id: string | null;
  latest_model: string | null;
  latest_context_usage_ratio: number | null;
  max_context_tokens: number | null;
  warning_level: string;
  version: number;
  updated_at_ms: string | number;
}

export function mapAgentSessionRow(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    ...(row.title === null ? {} : { title: row.title }),
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
    ...(row.retry_of_job_id === null ? {} : { retryOfJobId: row.retry_of_job_id }),
    ...(row.client_request_id === null ? {} : { clientRequestId: row.client_request_id }),
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
    ...(row.plan_step_id === null ? {} : { planStepId: row.plan_step_id }),
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
    ...(row.plan_step_id === null ? {} : { planStepId: row.plan_step_id }),
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
    ...(row.plan_step_id === null ? {} : { planStepId: row.plan_step_id }),
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
    key: row.key,
    position: row.position,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    status: row.status as AgentPlanStepStatus,
    ...(row.result === null ? {} : {
      result: mapRecord(row.result, 'agent_plan_steps.result'),
    }),
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

export function mapAgentContextSummaryRow(row: AgentContextSummaryRow): AgentContextSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    ownerType: row.owner_type as AgentContextOwnerType,
    ownerId: row.owner_id,
    purpose: row.purpose as AgentContextPurpose,
    contextRulesVersion: row.context_rules_version,
    summaryType: row.summary_type as AgentContextSummaryType,
    status: row.status as AgentContextSummaryStatus,
    sourceRowIdStart: mapBigint(row.source_row_id_start, 'agent_context_summaries.source_row_id_start'),
    sourceRowIdEnd: mapBigint(row.source_row_id_end, 'agent_context_summaries.source_row_id_end'),
    ...(row.parent_summary_id === null ? {} : { parentSummaryId: row.parent_summary_id }),
    ...(row.replaces_summary_id === null ? {} : { replacesSummaryId: row.replaces_summary_id }),
    summary: row.summary,
    summaryFormat: row.summary_format as 'markdown' | 'json',
    sourceMessageCount: row.source_message_count,
    ...(row.source_token_count === null ? {} : { sourceTokenCount: row.source_token_count }),
    ...(row.summary_token_count === null ? {} : { summaryTokenCount: row.summary_token_count }),
    ...(row.model === null ? {} : { model: row.model }),
    compressionPromptVersion: row.compression_prompt_version,
    checksum: row.checksum,
    version: row.version,
    ...(row.metadata === null
      ? {}
      : { metadata: mapRecord(row.metadata, 'agent_context_summaries.metadata') }),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_context_summaries.created_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_context_summaries.updated_at_ms'),
  };
}

export function mapAgentModelCallRow(row: AgentModelCallRow): AgentModelCall {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    logicalCallKey: row.logical_call_key,
    callAttemptNo: row.call_attempt_no,
    callType: row.call_type as AgentModelCallType,
    status: row.status as AgentModelCallStatus,
    provider: row.provider,
    model: row.model,
    contextRulesVersion: row.context_rules_version,
    inputManifest: mapRecord(row.input_manifest, 'agent_model_calls.input_manifest') as unknown as AgentContextInputManifest,
    inputMessages: mapArray(row.input_messages, 'agent_model_calls.input_messages') as StoredMessage[],
    inputChecksum: row.input_checksum,
    maxContextTokens: row.max_context_tokens,
    reservedOutputTokens: row.reserved_output_tokens,
    estimatedInputTokens: row.estimated_input_tokens,
    ...(row.actual_input_tokens === null ? {} : { actualInputTokens: row.actual_input_tokens }),
    ...(row.actual_output_tokens === null ? {} : { actualOutputTokens: row.actual_output_tokens }),
    ...(row.actual_total_tokens === null ? {} : { actualTotalTokens: row.actual_total_tokens }),
    ...(row.cache_read_input_tokens === null ? {} : { cacheReadInputTokens: row.cache_read_input_tokens }),
    ...(row.cache_write_input_tokens === null ? {} : { cacheWriteInputTokens: row.cache_write_input_tokens }),
    usageSource: row.usage_source as AgentModelUsageSource,
    ...(row.output_id === null ? {} : { outputId: row.output_id }),
    ...(row.result_type === null ? {} : { resultType: row.result_type }),
    ...(row.result_payload === null ? {} : { resultPayload: row.result_payload }),
    ...(row.tool_names === null ? {} : { toolNames: row.tool_names as string[] }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.error_details === null ? {} : { errorDetails: row.error_details }),
    ...(row.metadata === null ? {} : { metadata: mapRecord(row.metadata, 'agent_model_calls.metadata') }),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_model_calls.created_at_ms'),
    ...(row.completed_at_ms === null
      ? {}
      : { completedAtMs: mapBigint(row.completed_at_ms, 'agent_model_calls.completed_at_ms') }),
  };
}

export function mapAgentModelUsageStatsRow(row: AgentModelUsageStatsRow): AgentModelUsageStats {
  return {
    sessionId: row.session_id,
    totalModelCalls: row.total_model_calls,
    totalEstimatedInputTokens: mapBigint(row.total_estimated_input_tokens, 'usage.estimated'),
    totalActualInputTokens: mapBigint(row.total_actual_input_tokens, 'usage.actual_input'),
    totalActualOutputTokens: mapBigint(row.total_actual_output_tokens, 'usage.actual_output'),
    totalCacheReadInputTokens: mapBigint(row.total_cache_read_input_tokens, 'usage.cache_read'),
    totalCacheWriteInputTokens: mapBigint(row.total_cache_write_input_tokens, 'usage.cache_write'),
    totalTokens: mapBigint(row.total_tokens, 'usage.total'),
    ...(row.latest_model_call_id === null ? {} : { latestModelCallId: row.latest_model_call_id }),
    ...(row.latest_model === null ? {} : { latestModel: row.latest_model }),
    ...(row.latest_context_usage_ratio === null
      ? {}
      : { latestContextUsageRatio: row.latest_context_usage_ratio }),
    ...(row.max_context_tokens === null ? {} : { maxContextTokens: row.max_context_tokens }),
    warningLevel: row.warning_level as AgentModelUsageStats['warningLevel'],
    version: row.version,
    updatedAtMs: mapBigint(row.updated_at_ms, 'usage.updated_at_ms'),
  };
}

function mapBigint(value: string | number, field: string): number {
  const mapped = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(mapped)) {
    throw new RangeError(`${field} is outside the JavaScript safe integer range.`);
  }
  return mapped;
}

function mapArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be a JSON array.`);
  return value;
}

function mapRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}
