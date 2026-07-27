import type { PoolClient } from 'pg';
import type {
  AgentLoopCheckpointPhase
} from '../../../domain/index.js';
import {
  AgentStoreError
} from '../../agent-store.js';
import {
  type AgentJobRow,
  type AgentLoopCheckpointRow,
  type AgentMessageRow,
  type AgentToolInvocationRow,
  type AgentUserInputRequestRow
} from '../row-mappers.js';

interface PostgresErrorLike {
  code?: string;
  constraint?: string;
}

export function assertJobLease(
  job: AgentJobRow,
  workerId: string | undefined,
  attemptId: string | undefined,
  nowMs: number
): void {
  const leaseExpiresAtMs = job.lease_expires_at_ms === null
    ? undefined
    : Number(job.lease_expires_at_ms);
  if (
    !['running', 'resuming'].includes(job.status)
    || job.lease_owner !== workerId
    || job.current_attempt_id !== attemptId
    || leaseExpiresAtMs === undefined
    || leaseExpiresAtMs <= nowMs
  ) {
    throw new AgentStoreError(
      'JOB_LEASE_LOST',
      `Job ${JSON.stringify(job.id)} is not owned by the supplied worker attempt.`,
      { jobId: job.id, workerId, attemptId }
    );
  }
}

export function assertFutureLease(nowMs: number, leaseUntilMs: number): void {
  if (leaseUntilMs <= nowMs) {
    throw new RangeError('leaseUntilMs must be greater than nowMs.');
  }
}

export async function selectJob(client: PoolClient, jobId: string): Promise<AgentJobRow | undefined> {
  const result = await client.query<AgentJobRow>(
    `select * from agent_jobs where id = $1`,
    [jobId]
  );
  return result.rows[0];
}

export async function selectToolInvocation(
  client: PoolClient,
  jobId: string,
  toolCallId: string
): Promise<AgentToolInvocationRow | undefined> {
  const result = await client.query<AgentToolInvocationRow>(
    `select *
     from agent_tool_invocations
     where job_id = $1 and tool_call_id = $2`,
    [jobId, toolCallId]
  );
  return result.rows[0];
}

export interface AppendLoopCheckpointInput {
  sessionId: string;
  jobId: string;
  attemptId: string;
  phase: AgentLoopCheckpointPhase;
  callMessageId?: string;
  iterationNo: number;
  executedToolCalls: number;
  metadata?: Record<string, unknown>;
  nowMs: number;
}

export async function selectLatestLoopCheckpoint(
  client: PoolClient,
  jobId: string
): Promise<AgentLoopCheckpointRow | undefined> {
  const result = await client.query<AgentLoopCheckpointRow>(
    `select *
     from agent_loop_checkpoints
     where job_id = $1
     order by sequence_no desc
     limit 1`,
    [jobId]
  );
  return result.rows[0];
}

export async function appendLoopCheckpoint(
  client: PoolClient,
  input: AppendLoopCheckpointInput
): Promise<AgentLoopCheckpointRow> {
  const latest = await selectLatestLoopCheckpoint(client, input.jobId);
  const sequenceNo = (latest?.sequence_no ?? 0) + 1;
  const id = `${input.jobId}:checkpoint:${sequenceNo}`;
  const result = await client.query<AgentLoopCheckpointRow>(
    `insert into agent_loop_checkpoints(
       id, session_id, job_id, attempt_id, sequence_no, phase,
       call_message_id, iteration_no, executed_tool_calls, metadata, created_at_ms
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      id,
      input.sessionId,
      input.jobId,
      input.attemptId,
      sequenceNo,
      input.phase,
      input.callMessageId ?? null,
      input.iterationNo,
      input.executedToolCalls,
      input.metadata ?? null,
      input.nowMs,
    ]
  );
  return requireRow(result.rows[0], 'append loop checkpoint');
}

export async function resolveActivePlanScope(
  client: PoolClient,
  jobId: string
): Promise<{ planId: string; planStepId?: string } | undefined> {
  const result = await client.query<{ plan_id: string; plan_step_id: string | null }>(
    `select plan.id as plan_id, step.id as plan_step_id
     from agent_plans plan
     left join agent_plan_steps step
       on step.plan_id = plan.id and step.status = 'in_progress'
     where plan.job_id = $1 and plan.status = 'active'`,
    [jobId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    planId: row.plan_id,
    ...(row.plan_step_id ? { planStepId: row.plan_step_id } : {}),
  };
}

export async function selectUserInputRequest(
  client: PoolClient,
  requestId: string
): Promise<AgentUserInputRequestRow | undefined> {
  const result = await client.query<AgentUserInputRequestRow>(
    `select * from agent_user_input_requests where id = $1`,
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

export function userInputNotFound(requestId: string): AgentStoreError {
  return new AgentStoreError(
    'USER_INPUT_REQUEST_NOT_FOUND',
    `User input request ${JSON.stringify(requestId)} was not found.`,
    { requestId }
  );
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

export function jobNotFound(jobId: string): AgentStoreError {
  return new AgentStoreError(
    'JOB_NOT_FOUND',
    `Agent Job ${JSON.stringify(jobId)} was not found.`,
    { jobId }
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

export function mergeStringLists(
  left: string[] | undefined,
  right: string[] | undefined
): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])])];
}
