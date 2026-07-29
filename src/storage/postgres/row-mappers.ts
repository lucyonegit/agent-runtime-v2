import type { StoredMessage } from '@langchain/core/messages';
import type {
  AgentActivePlan,
  AgentArtifact,
  AgentArtifactArea,
  AgentArtifactKind,
  AgentContextCompaction,
  AgentContextInputManifest,
  AgentMessage,
  AgentMessageChannel,
  AgentMessageContextScope,
  AgentMessageRole,
  AgentMessageToolCall,
  AgentMessageType,
  AgentMessageVisibility,
  AgentModelCall,
  AgentModelCallStatus,
  AgentModelCallType,
  AgentModelOutputDisposition,
  AgentModelUsageSource,
  AgentModelUsageStats,
  AgentPlanStep,
  AgentSession,
  AgentSessionStatus,
  AgentTask,
  AgentTaskCheckpoint,
  AgentTaskCheckpointPhase,
  AgentTaskRun,
  AgentTaskRunStatus,
  AgentTaskRunTrigger,
  AgentTaskStatus,
  AgentToolCall,
  AgentToolCallStatus,
  AgentToolResult,
  AgentToolSideEffectLevel,
  AgentUserInputRequest,
  AgentUserInputRequestKind,
  AgentUserInputSchema,
  AgentUserInputStatus,
} from '../../domain/index.js';

type DbBigint = string | number;

export interface AgentSessionRow {
  id: string;
  title: string | null;
  status: string;
  version: number;
  created_at_ms: DbBigint;
  updated_at_ms: DbBigint;
}

export interface AgentTaskRow {
  id: string;
  session_id: string;
  goal_message_id: string;
  client_request_id: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
  version: number;
  metadata: unknown;
  created_at_ms: DbBigint;
  updated_at_ms: DbBigint;
  started_at_ms: DbBigint | null;
  completed_at_ms: DbBigint | null;
}

export interface AgentTaskRunRow {
  id: string;
  task_id: string;
  run_no: number;
  trigger: string;
  status: string;
  owner_id: string | null;
  ownership_expires_at_ms: DbBigint | null;
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
  metadata: unknown;
  started_at_ms: DbBigint;
  updated_at_ms: DbBigint;
  ended_at_ms: DbBigint | null;
}

export interface AgentMessageRow {
  row_id: DbBigint;
  id: string;
  session_id: string;
  task_id: string;
  task_run_id: string | null;
  output_id: string | null;
  role: string;
  message_type: string;
  context_scope: string;
  visibility: string;
  channel: string | null;
  content: string;
  tool_calls: unknown;
  model_tool_call_id: string | null;
  tool_name: string | null;
  tool_result: unknown;
  metadata: unknown;
  created_at_ms: DbBigint;
}

export interface AgentTaskCheckpointRow {
  id: string;
  session_id: string;
  task_id: string;
  task_run_id: string;
  sequence_no: number;
  phase: string;
  call_message_id: string | null;
  iteration_no: number;
  executed_tool_calls: number;
  metadata: unknown;
  created_at_ms: DbBigint;
}

export interface AgentToolCallRow {
  id: string;
  session_id: string;
  task_id: string;
  created_in_task_run_id: string;
  call_message_id: string;
  result_message_id: string | null;
  model_tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  arguments_checksum: string;
  side_effect_level: string;
  idempotency_key: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
  version: number;
  metadata: unknown;
  created_at_ms: DbBigint;
  started_at_ms: DbBigint | null;
  completed_at_ms: DbBigint | null;
  updated_at_ms: DbBigint;
}

export interface AgentActivePlanRow {
  session_id: string;
  task_id: string;
  title: string;
  steps: unknown;
  version: number;
  created_at_ms: DbBigint;
  updated_at_ms: DbBigint;
}

export interface AgentArtifactRow {
  id: string;
  session_id: string;
  task_id: string;
  tool_call_id: string;
  result_message_id: string;
  kind: string;
  area: string;
  title: string;
  file_name: string;
  logical_path: string;
  storage_path: string;
  media_type: string;
  size_bytes: DbBigint;
  checksum: string;
  revision: number;
  metadata: unknown;
  created_at_ms: DbBigint;
}

export interface AgentUserInputRequestRow {
  id: string;
  session_id: string;
  task_id: string;
  tool_call_id: string;
  kind: string;
  status: string;
  title: string | null;
  prompt: string;
  input_schema: unknown;
  answer_message_id: string | null;
  client_answer_id: string | null;
  expires_at_ms: DbBigint | null;
  version: number;
  metadata: unknown;
  created_at_ms: DbBigint;
  updated_at_ms: DbBigint;
  answered_at_ms: DbBigint | null;
}

export interface AgentContextCompactionRow {
  session_id: string;
  through_message_row_id: DbBigint;
  summary: string;
  version: number;
  updated_at_ms: DbBigint;
}

export interface AgentModelCallRow {
  id: string;
  session_id: string;
  task_id: string;
  task_run_id: string;
  logical_call_key: string;
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
  output_disposition: string | null;
  output_disposition_reason: string | null;
  result_type: string | null;
  result_payload: unknown;
  tool_names: unknown;
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
  metadata: unknown;
  created_at_ms: DbBigint;
  completed_at_ms: DbBigint | null;
}

export interface AgentModelUsageStatsRow {
  session_id: string;
  total_model_calls: number;
  total_estimated_input_tokens: DbBigint;
  total_actual_input_tokens: DbBigint;
  total_actual_output_tokens: DbBigint;
  total_cache_read_input_tokens: DbBigint;
  total_cache_write_input_tokens: DbBigint;
  total_tokens: DbBigint;
  latest_model_call_id: string | null;
  latest_model: string | null;
  latest_context_usage_ratio: number | null;
  max_context_tokens: number | null;
  warning_level: string;
  version: number;
  updated_at_ms: DbBigint;
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

export function mapAgentTaskRow(row: AgentTaskRow): AgentTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    goalMessageId: row.goal_message_id,
    ...(row.client_request_id === null ? {} : { clientRequestId: row.client_request_id }),
    status: row.status as AgentTaskStatus,
    ...mapExecutionError(row),
    version: row.version,
    ...mapMetadata(row.metadata, 'agent_tasks.metadata'),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_tasks.created_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_tasks.updated_at_ms'),
    ...mapOptionalBigint('startedAtMs', row.started_at_ms, 'agent_tasks.started_at_ms'),
    ...mapOptionalBigint('completedAtMs', row.completed_at_ms, 'agent_tasks.completed_at_ms'),
  };
}

export function mapAgentTaskRunRow(row: AgentTaskRunRow): AgentTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    runNo: row.run_no,
    trigger: row.trigger as AgentTaskRunTrigger,
    status: row.status as AgentTaskRunStatus,
    ...(row.owner_id === null ? {} : { ownerId: row.owner_id }),
    ...mapOptionalBigint(
      'ownershipExpiresAtMs',
      row.ownership_expires_at_ms,
      'agent_task_runs.ownership_expires_at_ms'
    ),
    ...mapExecutionError(row),
    ...mapMetadata(row.metadata, 'agent_task_runs.metadata'),
    startedAtMs: mapBigint(row.started_at_ms, 'agent_task_runs.started_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_task_runs.updated_at_ms'),
    ...mapOptionalBigint('endedAtMs', row.ended_at_ms, 'agent_task_runs.ended_at_ms'),
  };
}

export function mapAgentMessageRow(row: AgentMessageRow): AgentMessage {
  return {
    rowId: mapBigint(row.row_id, 'agent_messages.row_id'),
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    ...(row.task_run_id === null ? {} : { taskRunId: row.task_run_id }),
    ...(row.output_id === null ? {} : { outputId: row.output_id }),
    role: row.role as AgentMessageRole,
    messageType: row.message_type as AgentMessageType,
    contextScope: row.context_scope as AgentMessageContextScope,
    visibility: row.visibility as AgentMessageVisibility,
    ...(row.channel === null ? {} : { channel: row.channel as AgentMessageChannel }),
    content: row.content,
    ...(row.tool_calls === null
      ? {}
      : { toolCalls: mapArray(row.tool_calls, 'agent_messages.tool_calls') as AgentMessageToolCall[] }),
    ...(row.model_tool_call_id === null ? {} : { modelToolCallId: row.model_tool_call_id }),
    ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
    ...(row.tool_result === null ? {} : { toolResult: row.tool_result as AgentToolResult }),
    ...mapMetadata(row.metadata, 'agent_messages.metadata'),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_messages.created_at_ms'),
  };
}

export function mapAgentTaskCheckpointRow(row: AgentTaskCheckpointRow): AgentTaskCheckpoint {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    taskRunId: row.task_run_id,
    sequenceNo: row.sequence_no,
    phase: row.phase as AgentTaskCheckpointPhase,
    ...(row.call_message_id === null ? {} : { callMessageId: row.call_message_id }),
    iterationNo: row.iteration_no,
    executedToolCalls: row.executed_tool_calls,
    ...mapMetadata(row.metadata, 'agent_task_checkpoints.metadata'),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_task_checkpoints.created_at_ms'),
  };
}

export function mapAgentToolCallRow(row: AgentToolCallRow): AgentToolCall {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    createdInTaskRunId: row.created_in_task_run_id,
    callMessageId: row.call_message_id,
    ...(row.result_message_id === null ? {} : { resultMessageId: row.result_message_id }),
    modelToolCallId: row.model_tool_call_id,
    toolName: row.tool_name,
    arguments: mapRecord(row.arguments, 'agent_tool_calls.arguments'),
    argumentsChecksum: row.arguments_checksum,
    sideEffectLevel: row.side_effect_level as AgentToolSideEffectLevel,
    idempotencyKey: row.idempotency_key,
    status: row.status as AgentToolCallStatus,
    ...mapExecutionError(row),
    version: row.version,
    ...mapMetadata(row.metadata, 'agent_tool_calls.metadata'),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_tool_calls.created_at_ms'),
    ...mapOptionalBigint('startedAtMs', row.started_at_ms, 'agent_tool_calls.started_at_ms'),
    ...mapOptionalBigint('completedAtMs', row.completed_at_ms, 'agent_tool_calls.completed_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_tool_calls.updated_at_ms'),
  };
}

export function mapAgentActivePlanRow(row: AgentActivePlanRow): AgentActivePlan {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    title: row.title,
    steps: mapArray(row.steps, 'agent_active_plans.steps') as AgentPlanStep[],
    version: row.version,
    createdAtMs: mapBigint(row.created_at_ms, 'agent_active_plans.created_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_active_plans.updated_at_ms'),
  };
}

export function mapAgentArtifactRow(row: AgentArtifactRow): AgentArtifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    toolCallId: row.tool_call_id,
    resultMessageId: row.result_message_id,
    kind: row.kind as AgentArtifactKind,
    area: row.area as AgentArtifactArea,
    title: row.title,
    fileName: row.file_name,
    logicalPath: row.logical_path,
    storagePath: row.storage_path,
    mediaType: row.media_type,
    size: mapBigint(row.size_bytes, 'agent_artifacts.size_bytes'),
    checksum: row.checksum,
    revision: row.revision,
    ...mapMetadata(row.metadata, 'agent_artifacts.metadata'),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_artifacts.created_at_ms'),
  };
}

export function mapAgentUserInputRequestRow(row: AgentUserInputRequestRow): AgentUserInputRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    toolCallId: row.tool_call_id,
    kind: row.kind as AgentUserInputRequestKind,
    status: row.status as AgentUserInputStatus,
    ...(row.title === null ? {} : { title: row.title }),
    prompt: row.prompt,
    inputSchema: mapRecord(
      row.input_schema,
      'agent_user_input_requests.input_schema'
    ) as AgentUserInputSchema,
    ...(row.answer_message_id === null ? {} : { answerMessageId: row.answer_message_id }),
    ...(row.client_answer_id === null ? {} : { clientAnswerId: row.client_answer_id }),
    ...mapOptionalBigint('expiresAtMs', row.expires_at_ms, 'agent_user_input_requests.expires_at_ms'),
    version: row.version,
    ...mapMetadata(row.metadata, 'agent_user_input_requests.metadata'),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_user_input_requests.created_at_ms'),
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_user_input_requests.updated_at_ms'),
    ...mapOptionalBigint('answeredAtMs', row.answered_at_ms, 'agent_user_input_requests.answered_at_ms'),
  };
}

export function mapAgentContextCompactionRow(row: AgentContextCompactionRow): AgentContextCompaction {
  return {
    sessionId: row.session_id,
    throughMessageRowId: mapBigint(
      row.through_message_row_id,
      'agent_context_compactions.through_message_row_id'
    ),
    summary: row.summary,
    version: row.version,
    updatedAtMs: mapBigint(row.updated_at_ms, 'agent_context_compactions.updated_at_ms'),
  };
}

export function mapAgentModelCallRow(row: AgentModelCallRow): AgentModelCall {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    taskRunId: row.task_run_id,
    logicalCallKey: row.logical_call_key,
    callType: row.call_type as AgentModelCallType,
    status: row.status as AgentModelCallStatus,
    provider: row.provider,
    model: row.model,
    contextRulesVersion: row.context_rules_version,
    inputManifest: mapRecord(
      row.input_manifest,
      'agent_model_calls.input_manifest'
    ) as unknown as AgentContextInputManifest,
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
    ...(row.output_disposition === null
      ? {}
      : { outputDisposition: row.output_disposition as AgentModelOutputDisposition }),
    ...(row.output_disposition_reason === null
      ? {}
      : { outputDispositionReason: row.output_disposition_reason }),
    ...(row.result_type === null ? {} : { resultType: row.result_type }),
    ...(row.result_payload === null ? {} : { resultPayload: row.result_payload }),
    ...(row.tool_names === null
      ? {}
      : { toolNames: mapArray(row.tool_names, 'agent_model_calls.tool_names') as string[] }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.error_details === null ? {} : { errorDetails: row.error_details }),
    ...mapMetadata(row.metadata, 'agent_model_calls.metadata'),
    createdAtMs: mapBigint(row.created_at_ms, 'agent_model_calls.created_at_ms'),
    ...mapOptionalBigint('completedAtMs', row.completed_at_ms, 'agent_model_calls.completed_at_ms'),
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

function mapExecutionError(row: {
  error_code: string | null;
  error_message: string | null;
  error_details: unknown;
}): { error?: { code: string; message: string; details?: unknown } } {
  if (row.error_code === null || row.error_message === null) return {};
  return {
    error: {
      code: row.error_code,
      message: row.error_message,
      ...(row.error_details === null ? {} : { details: row.error_details }),
    },
  };
}

function mapMetadata(value: unknown, field: string): { metadata?: Record<string, unknown> } {
  return value === null ? {} : { metadata: mapRecord(value, field) };
}

function mapOptionalBigint<Key extends string>(
  key: Key,
  value: DbBigint | null,
  field: string
): Partial<Record<Key, number>> {
  return value === null ? {} : { [key]: mapBigint(value, field) } as Partial<Record<Key, number>>;
}

function mapBigint(value: DbBigint, field: string): number {
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
