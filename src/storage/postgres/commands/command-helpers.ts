import type { PoolClient } from 'pg';
import type { AgentTaskCheckpointPhase } from '../../../domain/index.js';
import { AgentStoreError } from '../../agent-store.js';
import type {
  AgentMessageRow,
  AgentTaskCheckpointRow,
  AgentTaskRow,
  AgentTaskRunRow,
  AgentToolCallRow,
  AgentUserInputRequestRow,
} from '../row-mappers.js';

interface PostgresErrorLike {
  code?: string;
  constraint?: string;
}

export function assertFutureOwnership(nowMs: number, ownershipExpiresAtMs: number): void {
  if (ownershipExpiresAtMs <= nowMs) {
    throw new RangeError('ownershipExpiresAtMs must be greater than nowMs.');
  }
}

export async function selectTask(
  client: PoolClient,
  taskId: string,
  lock = false
): Promise<AgentTaskRow | undefined> {
  const result = await client.query<AgentTaskRow>(
    `select * from agent_tasks where id = $1${lock ? ' for update' : ''}`,
    [taskId]
  );
  return result.rows[0];
}

export async function selectTaskRun(
  client: PoolClient,
  taskRunId: string,
  lock = false
): Promise<AgentTaskRunRow | undefined> {
  const result = await client.query<AgentTaskRunRow>(
    `select * from agent_task_runs where id = $1${lock ? ' for update' : ''}`,
    [taskRunId]
  );
  return result.rows[0];
}

export function assertTaskRunOwnership(
  task: AgentTaskRow,
  taskRun: AgentTaskRunRow | undefined,
  ownerId: string,
  nowMs: number
): asserts taskRun is AgentTaskRunRow {
  const expiresAt = taskRun?.ownership_expires_at_ms === null
    || taskRun?.ownership_expires_at_ms === undefined
    ? undefined
    : Number(taskRun.ownership_expires_at_ms);
  if (
    task.status !== 'running'
    || !taskRun
    || taskRun.task_id !== task.id
    || taskRun.status !== 'running'
    || taskRun.owner_id !== ownerId
    || expiresAt === undefined
    || expiresAt <= nowMs
  ) {
    throw new AgentStoreError(
      'TASK_OWNERSHIP_LOST',
      `Task run ${JSON.stringify(taskRun?.id)} is no longer owned by ${JSON.stringify(ownerId)}.`,
      { taskId: task.id, taskRunId: taskRun?.id, ownerId }
    );
  }
}

export async function selectToolCall(
  client: PoolClient,
  taskId: string,
  modelToolCallId: string,
  lock = false
): Promise<AgentToolCallRow | undefined> {
  const result = await client.query<AgentToolCallRow>(
    `select *
     from agent_tool_calls
     where task_id = $1 and model_tool_call_id = $2${lock ? ' for update' : ''}`,
    [taskId, modelToolCallId]
  );
  return result.rows[0];
}

export async function selectLatestTaskCheckpoint(
  client: PoolClient,
  taskId: string
): Promise<AgentTaskCheckpointRow | undefined> {
  const result = await client.query<AgentTaskCheckpointRow>(
    `select *
     from agent_task_checkpoints
     where task_id = $1
     order by sequence_no desc
     limit 1`,
    [taskId]
  );
  return result.rows[0];
}

export interface AppendTaskCheckpointInput {
  sessionId: string;
  taskId: string;
  taskRunId: string;
  phase: AgentTaskCheckpointPhase;
  callMessageId?: string;
  iterationNo: number;
  executedToolCalls: number;
  metadata?: Record<string, unknown>;
  nowMs: number;
}

export async function appendTaskCheckpoint(
  client: PoolClient,
  input: AppendTaskCheckpointInput
): Promise<AgentTaskCheckpointRow> {
  const sequenceResult = await client.query<{ sequence_no: number }>(
    `select coalesce(max(sequence_no), 0)::integer + 1 as sequence_no
     from agent_task_checkpoints
     where task_id = $1`,
    [input.taskId]
  );
  const sequenceNo = requireRow(sequenceResult.rows[0], 'select checkpoint sequence').sequence_no;
  const result = await client.query<AgentTaskCheckpointRow>(
    `insert into agent_task_checkpoints(
       id, session_id, task_id, task_run_id, sequence_no, phase,
       call_message_id, iteration_no, executed_tool_calls, metadata, created_at_ms
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      `${input.taskId}:checkpoint:${sequenceNo}`,
      input.sessionId,
      input.taskId,
      input.taskRunId,
      sequenceNo,
      input.phase,
      input.callMessageId ?? null,
      input.iterationNo,
      input.executedToolCalls,
      input.metadata ?? null,
      input.nowMs,
    ]
  );
  return requireRow(result.rows[0], 'append task checkpoint');
}

export async function selectUserInputRequest(
  client: PoolClient,
  requestId: string,
  lock = false
): Promise<AgentUserInputRequestRow | undefined> {
  const result = await client.query<AgentUserInputRequestRow>(
    `select * from agent_user_input_requests where id = $1${lock ? ' for update' : ''}`,
    [requestId]
  );
  return result.rows[0];
}

export async function selectMessageById(
  client: PoolClient,
  messageId: string
): Promise<AgentMessageRow | undefined> {
  const result = await client.query<AgentMessageRow>(
    `select * from agent_messages where id = $1`,
    [messageId]
  );
  return result.rows[0];
}

export async function touchSession(
  client: PoolClient,
  sessionId: string,
  nowMs: number
): Promise<void> {
  await client.query(
    `update agent_sessions
     set version = version + 1, updated_at_ms = $2
     where id = $1`,
    [sessionId, nowMs]
  );
}

export function taskNotFound(taskId: string): AgentStoreError {
  return new AgentStoreError(
    'TASK_NOT_FOUND',
    `Task ${JSON.stringify(taskId)} was not found.`,
    { taskId }
  );
}

export function taskRunNotFound(taskRunId: string): AgentStoreError {
  return new AgentStoreError(
    'TASK_RUN_NOT_FOUND',
    `TaskRun ${JSON.stringify(taskRunId)} was not found.`,
    { taskRunId }
  );
}

export function toolCallNotFound(taskId: string, modelToolCallId: string): AgentStoreError {
  return new AgentStoreError(
    'TOOL_CALL_NOT_FOUND',
    `ToolCall ${JSON.stringify(modelToolCallId)} was not found in Task ${JSON.stringify(taskId)}.`,
    { taskId, modelToolCallId }
  );
}

export function userInputNotFound(requestId: string): AgentStoreError {
  return new AgentStoreError(
    'USER_INPUT_REQUEST_NOT_FOUND',
    `UserInputRequest ${JSON.stringify(requestId)} was not found.`,
    { requestId }
  );
}

export function isConstraint(error: unknown, constraint: string): boolean {
  const pgError = error as PostgresErrorLike;
  return pgError?.code === '23505' && pgError.constraint === constraint;
}

export function requireRow<T>(row: T | undefined, operation: string): T {
  if (!row) throw new Error(`PostgreSQL did not return a row for ${operation}.`);
  return row;
}
