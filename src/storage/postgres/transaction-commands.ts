import type { PoolClient } from 'pg';
import type { AgentJob, AgentMessage, AgentSession } from '../../domain/index.js';
import {
  AgentStoreError,
  type CancelJobInput,
  type ClaimJobInput,
  type ClaimToolInvocationInput,
  type ClaimToolInvocationResult,
  type CommitModelToolCallsInput,
  type CommitModelToolCallsResult,
  type CommitToolResultInput,
  type CommitToolResultResult,
  type CreateJobAndAppendUserMessageInput,
  type CreateJobAndAppendUserMessageResult,
  type CreateSessionInput,
  type FailJobInput,
  type RenewJobLeaseInput,
} from '../agent-store.js';
import {
  mapAgentJobRow,
  mapAgentMessageRow,
  mapAgentSessionRow,
  mapAgentToolInvocationRow,
  type AgentJobRow,
  type AgentMessageRow,
  type AgentSessionRow,
  type AgentToolInvocationRow,
} from './row-mappers.js';
import { lockAgentSession, withPostgresTransaction } from './sql.js';

interface PostgresErrorLike {
  code?: string;
  constraint?: string;
}

export async function createSessionCommand(
  client: PoolClient,
  input: CreateSessionInput
): Promise<AgentSession> {
  try {
    const result = await client.query<AgentSessionRow>(
      `insert into agent_sessions(
         id, title, mode, status, version, created_at_ms, updated_at_ms
       ) values ($1, $2, $3, 'active', 0, $4, $4)
       returning *`,
      [input.id, input.title ?? null, input.mode, input.nowMs]
    );
    return mapAgentSessionRow(requireRow(result.rows[0], 'create session'));
  } catch (error) {
    if (isConstraint(error, 'agent_sessions_pkey')) {
      throw new AgentStoreError(
        'SESSION_ALREADY_EXISTS',
        `Agent session ${JSON.stringify(input.id)} already exists.`,
        { sessionId: input.id }
      );
    }
    throw error;
  }
}

export async function createJobAndAppendUserMessageCommand(
  client: PoolClient,
  input: CreateJobAndAppendUserMessageInput
): Promise<CreateJobAndAppendUserMessageResult> {
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    if (input.clientRequestId) {
      const existingRequest = await client.query<{ id: string }>(
        `select id
         from agent_jobs
         where session_id = $1 and client_request_id = $2`,
        [input.sessionId, input.clientRequestId]
      );
      if (existingRequest.rows[0]) {
        throw new AgentStoreError(
          'CLIENT_REQUEST_CONFLICT',
          `Client request ${JSON.stringify(input.clientRequestId)} was already used in this Session.`,
          {
            sessionId: input.sessionId,
            clientRequestId: input.clientRequestId,
            existingJobId: existingRequest.rows[0].id,
          }
        );
      }
    }
    if (input.retryOfJobId) {
      await assertValidRetry(client, input.sessionId, input.retryOfJobId);
    }

    let jobRow: AgentJobRow;
    try {
      const jobResult = await client.query<AgentJobRow>(
        `insert into agent_jobs(
           id, session_id, project_id, retry_of_job_id, client_request_id,
           stage, status, attempt_no, version, metadata,
           created_at_ms, updated_at_ms
         ) values (
           $1, $2, $3, $4, $5,
           'routing', 'created', 0, 0, $6,
           $7, $7
         )
         returning *`,
        [
          input.jobId,
          input.sessionId,
          input.projectId ?? null,
          input.retryOfJobId ?? null,
          input.clientRequestId ?? null,
          input.jobMetadata ?? null,
          input.nowMs,
        ]
      );
      jobRow = requireRow(jobResult.rows[0], 'create job');
    } catch (error) {
      throw mapCreateJobError(error, input);
    }

    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, job_id, role, message_type, visibility, channel,
         content, metadata, created_at_ms
       ) values (
         $1, $2, $3, 'user', 'user_message', 'ui', 'normal',
         $4, $5, $6
       )
       returning *`,
      [
        input.userMessageId,
        input.sessionId,
        input.jobId,
        input.content,
        input.messageMetadata ?? null,
        input.nowMs,
      ]
    );
    const sessionResult = await client.query<AgentSessionRow>(
      `update agent_sessions
       set version = version + 1,
           updated_at_ms = $2
       where id = $1
       returning *`,
      [input.sessionId, input.nowMs]
    );

    return {
      session: mapAgentSessionRow(requireRow(sessionResult.rows[0], 'update session')),
      job: mapAgentJobRow(jobRow),
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'append user message')),
    };
  });
}

export async function claimJobCommand(
  client: PoolClient,
  input: ClaimJobInput
): Promise<AgentJob> {
  assertFutureLease(input.nowMs, input.leaseUntilMs);
  const result = await client.query<AgentJobRow>(
    `update agent_jobs
     set status = 'running',
         lease_owner = $3,
         lease_expires_at_ms = $4,
         current_attempt_id = $5,
         attempt_no = attempt_no + 1,
         version = version + 1,
         started_at_ms = coalesce(started_at_ms, $6),
         updated_at_ms = $6
     where id = $1
       and version = $2
       and (
         status = 'created'
         or (
           status in ('running', 'resuming')
           and lease_expires_at_ms <= $6
         )
       )
     returning *`,
    [
      input.jobId,
      input.expectedVersion,
      input.workerId,
      input.leaseUntilMs,
      input.attemptId,
      input.nowMs,
    ]
  );
  const row = result.rows[0];
  if (row) return mapAgentJobRow(row);
  return throwJobMutationConflict(client, input.jobId, input.expectedVersion, 'claim');
}

export async function renewJobLeaseCommand(
  client: PoolClient,
  input: RenewJobLeaseInput
): Promise<AgentJob> {
  assertFutureLease(input.nowMs, input.leaseUntilMs);
  const result = await client.query<AgentJobRow>(
    `update agent_jobs
     set lease_expires_at_ms = $6,
         version = version + 1,
         updated_at_ms = $5
     where id = $1
       and version = $2
       and status in ('running', 'resuming')
       and lease_owner = $3
       and current_attempt_id = $4
       and lease_expires_at_ms > $5
     returning *`,
    [
      input.jobId,
      input.expectedVersion,
      input.workerId,
      input.attemptId,
      input.nowMs,
      input.leaseUntilMs,
    ]
  );
  const row = result.rows[0];
  if (row) return mapAgentJobRow(row);
  return throwJobMutationConflict(
    client,
    input.jobId,
    input.expectedVersion,
    'renew lease',
    true
  );
}

export async function commitModelToolCallsCommand(
  client: PoolClient,
  input: CommitModelToolCallsInput
): Promise<CommitModelToolCallsResult> {
  if (input.invocations.length === 0) {
    throw new TypeError('commitModelToolCalls requires at least one invocation.');
  }
  if (new Set(input.invocations.map(item => item.call.id)).size !== input.invocations.length) {
    throw new TypeError('Tool-call IDs must be unique within one model output.');
  }
  const initialJob = await selectJob(client, input.jobId);
  if (!initialJob) throw jobNotFound(input.jobId);
  if (initialJob.session_id !== input.sessionId) throw jobNotFound(input.jobId);

  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`,
      [input.jobId]
    );
    const job = requireRow(jobResult.rows[0], 'lock job for model tool calls');
    assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
    const step = await resolveStepRunScope(client, input.jobId, input.stepRunId);

    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, job_id, plan_id, step_id, step_run_id, attempt_id, output_id,
         role, message_type, visibility, channel, content, tool_calls, created_at_ms
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8,
         'assistant', 'tool_call', 'ui', 'normal', $9, $10, $11
       )
       returning *`,
      [
        input.messageId,
        input.sessionId,
        input.jobId,
        step?.planId ?? null,
        step?.stepId ?? null,
        input.stepRunId ?? null,
        input.attemptId,
        input.outputId,
        input.content,
        JSON.stringify(input.invocations.map(item => item.call)),
        input.nowMs,
      ]
    );
    const invocationRows: AgentToolInvocationRow[] = [];
    for (const invocation of input.invocations) {
      const result = await client.query<AgentToolInvocationRow>(
        `insert into agent_tool_invocations(
           id, session_id, job_id, plan_id, step_id, step_run_id, attempt_id,
           call_message_id, tool_call_id, tool_name, arguments, arguments_checksum,
           side_effect_level, idempotency_key, status, version, metadata,
           created_at_ms, updated_at_ms
         ) values (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12,
           $13, $14, 'pending', 0, $15,
           $16, $16
         )
         returning *`,
        [
          invocation.invocationId,
          input.sessionId,
          input.jobId,
          step?.planId ?? null,
          step?.stepId ?? null,
          input.stepRunId ?? null,
          input.attemptId,
          input.messageId,
          invocation.call.id,
          invocation.call.name,
          JSON.stringify(invocation.call.args),
          invocation.argumentsChecksum,
          invocation.sideEffectLevel,
          invocation.idempotencyKey,
          invocation.metadata ?? null,
          input.nowMs,
        ]
      );
      invocationRows.push(requireRow(result.rows[0], 'create tool invocation'));
    }
    return {
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'create tool-call message')),
      invocations: invocationRows.map(mapAgentToolInvocationRow),
    };
  });
}

export async function claimToolInvocationCommand(
  client: PoolClient,
  input: ClaimToolInvocationInput
): Promise<ClaimToolInvocationResult> {
  const result = await client.query<AgentToolInvocationRow>(
    `update agent_tool_invocations invocation
     set status = 'running',
         attempt_id = $4,
         version = invocation.version + 1,
         started_at_ms = coalesce(invocation.started_at_ms, $5),
         updated_at_ms = $5
     where invocation.job_id = $1
       and invocation.tool_call_id = $2
       and invocation.status = 'pending'
       and exists (
         select 1
         from agent_jobs job
         where job.id = invocation.job_id
           and job.status in ('running', 'resuming')
           and job.lease_owner = $3
           and job.current_attempt_id = $4
           and job.lease_expires_at_ms > $5
       )
     returning invocation.*`,
    [input.jobId, input.toolCallId, input.workerId, input.attemptId, input.nowMs]
  );
  if (result.rows[0]) {
    return { invocation: mapAgentToolInvocationRow(result.rows[0]), claimed: true };
  }

  const invocation = await selectToolInvocation(client, input.jobId, input.toolCallId);
  if (!invocation) {
    throw new AgentStoreError(
      'TOOL_INVOCATION_NOT_FOUND',
      `Tool invocation ${JSON.stringify(input.toolCallId)} was not found in Job ${JSON.stringify(input.jobId)}.`,
      { jobId: input.jobId, toolCallId: input.toolCallId }
    );
  }
  const job = await selectJob(client, input.jobId);
  if (!job) throw jobNotFound(input.jobId);
  assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
  if (['completed', 'failed', 'cancelled'].includes(invocation.status)) {
    return { invocation: mapAgentToolInvocationRow(invocation), claimed: false };
  }
  throw new AgentStoreError(
    'INVALID_TOOL_INVOCATION_STATE',
    `Tool invocation ${JSON.stringify(input.toolCallId)} cannot be claimed from status ${invocation.status}.`,
    { jobId: input.jobId, toolCallId: input.toolCallId, status: invocation.status }
  );
}

export async function commitToolResultCommand(
  client: PoolClient,
  input: CommitToolResultInput
): Promise<CommitToolResultResult> {
  const initialInvocation = await selectToolInvocation(client, input.jobId, input.toolCallId);
  if (!initialInvocation) {
    throw new AgentStoreError(
      'TOOL_INVOCATION_NOT_FOUND',
      `Tool invocation ${JSON.stringify(input.toolCallId)} was not found.`,
      { jobId: input.jobId, toolCallId: input.toolCallId }
    );
  }
  if (initialInvocation.session_id !== input.sessionId) {
    throw new AgentStoreError('TOOL_INVOCATION_NOT_FOUND', 'Tool invocation scope mismatch.');
  }

  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`,
      [input.jobId]
    );
    const job = requireRow(jobResult.rows[0], 'lock job for tool result');
    assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
    const invocationResult = await client.query<AgentToolInvocationRow>(
      `select *
       from agent_tool_invocations
       where job_id = $1 and tool_call_id = $2
       for update`,
      [input.jobId, input.toolCallId]
    );
    const invocation = requireRow(invocationResult.rows[0], 'lock tool invocation');
    if (invocation.status !== 'running' || invocation.attempt_id !== input.attemptId) {
      throw new AgentStoreError(
        'INVALID_TOOL_INVOCATION_STATE',
        `Tool invocation ${JSON.stringify(input.toolCallId)} is not running in this attempt.`,
        { status: invocation.status, invocationAttemptId: invocation.attempt_id }
      );
    }
    if ((input.stepRunId ?? null) !== invocation.step_run_id) {
      throw new AgentStoreError('TOOL_INVOCATION_CONFLICT', 'Tool result StepRun scope mismatch.');
    }

    const resultPayload = input.outcome.status === 'completed'
      ? {
          status: 'completed',
          result: input.outcome.result,
          durationMs: input.outcome.durationMs,
        }
      : {
          status: 'failed',
          error: input.outcome.message,
          durationMs: input.outcome.durationMs,
        };
    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, job_id, plan_id, step_id, step_run_id, attempt_id,
         role, message_type, visibility, channel, content,
         tool_call_id, tool_name, tool_result, created_at_ms
       ) values (
         $1, $2, $3, $4, $5, $6, $7,
         'tool', 'tool_result', 'ui', 'normal', $8,
         $9, $10, $11, $12
       )
       returning *`,
      [
        input.messageId,
        input.sessionId,
        input.jobId,
        invocation.plan_id,
        invocation.step_id,
        invocation.step_run_id,
        input.attemptId,
        input.outcome.status === 'completed' ? input.outcome.content : input.outcome.message,
        input.toolCallId,
        invocation.tool_name,
        JSON.stringify(resultPayload),
        input.nowMs,
      ]
    );
    const updatedInvocation = await client.query<AgentToolInvocationRow>(
      `update agent_tool_invocations
       set result_message_id = $3,
           status = $4,
           result_payload = $5,
           error_code = $6,
           error_message = $7,
           error_details = $8,
           version = version + 1,
           completed_at_ms = $9,
           updated_at_ms = $9
       where job_id = $1 and tool_call_id = $2
       returning *`,
      [
        input.jobId,
        input.toolCallId,
        input.messageId,
        input.outcome.status,
        input.outcome.status === 'completed' ? input.outcome.result ?? null : null,
        input.outcome.status === 'failed' ? input.outcome.code : null,
        input.outcome.status === 'failed' ? input.outcome.message : null,
        input.outcome.status === 'failed' ? input.outcome.details ?? null : null,
        input.nowMs,
      ]
    );
    return {
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'create tool-result message')),
      invocation: mapAgentToolInvocationRow(
        requireRow(updatedInvocation.rows[0], 'complete tool invocation')
      ),
    };
  });
}

export async function failJobCommand(
  client: PoolClient,
  input: FailJobInput
): Promise<AgentJob> {
  return terminateJobCommand(client, {
    ...input,
    terminalStatus: 'failed',
    requireLease: true,
  });
}

export async function cancelJobCommand(
  client: PoolClient,
  input: CancelJobInput
): Promise<AgentJob> {
  return terminateJobCommand(client, {
    ...input,
    terminalStatus: 'cancelled',
    requireLease: false,
  });
}

interface TerminateJobCommandInput {
  jobId: string;
  expectedVersion: number;
  nowMs: number;
  terminalStatus: 'failed' | 'cancelled';
  requireLease: boolean;
  workerId?: string;
  attemptId?: string;
  error?: { code: string; message: string; details?: unknown };
}

async function terminateJobCommand(
  client: PoolClient,
  input: TerminateJobCommandInput
): Promise<AgentJob> {
  const initialJob = await selectJob(client, input.jobId);
  if (!initialJob) throw jobNotFound(input.jobId);

  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, initialJob.session_id);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`,
      [input.jobId]
    );
    const job = jobResult.rows[0];
    if (!job) throw jobNotFound(input.jobId);
    assertExpectedVersion(job, input.expectedVersion);
    if (!['created', 'running', 'waiting_user_input', 'resuming'].includes(job.status)) {
      throw new AgentStoreError(
        'INVALID_JOB_STATE',
        `Cannot ${input.terminalStatus === 'failed' ? 'fail' : 'cancel'} Job ${JSON.stringify(input.jobId)} from status ${job.status}.`,
        { jobId: input.jobId, status: job.status }
      );
    }
    if (input.requireLease) {
      assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
    }

    await lockJobDescendants(client, input.jobId);
    await terminateJobDescendants(client, input);

    const updated = await client.query<AgentJobRow>(
      `update agent_jobs
       set status = $2,
           lease_owner = null,
           lease_expires_at_ms = null,
           error_code = $3,
           error_message = $4,
           error_details = $5,
           version = version + 1,
           updated_at_ms = $6,
           completed_at_ms = $6
       where id = $1
       returning *`,
      [
        input.jobId,
        input.terminalStatus,
        input.error?.code ?? null,
        input.error?.message ?? null,
        input.error?.details ?? null,
        input.nowMs,
      ]
    );
    return mapAgentJobRow(requireRow(updated.rows[0], 'terminate job'));
  });
}

async function lockJobDescendants(client: PoolClient, jobId: string): Promise<void> {
  await client.query(`select id from agent_plans where job_id = $1 order by id for update`, [jobId]);
  await client.query(
    `select step.id
     from agent_plan_steps step
     join agent_plans plan on plan.id = step.plan_id
     where plan.job_id = $1
     order by step.id
     for update of step`,
    [jobId]
  );
  await client.query(
    `select id from agent_step_runs where job_id = $1 order by id for update`,
    [jobId]
  );
  await client.query(
    `select id from agent_tool_invocations where job_id = $1 order by id for update`,
    [jobId]
  );
  await client.query(
    `select id from agent_user_input_requests where job_id = $1 order by id for update`,
    [jobId]
  );
}

async function terminateJobDescendants(
  client: PoolClient,
  input: TerminateJobCommandInput
): Promise<void> {
  const terminalStatus = input.terminalStatus;
  await client.query(
    `update agent_plans
     set status = $2, version = version + 1, updated_at_ms = $3, completed_at_ms = $3
     where job_id = $1
       and status in ('draft', 'active', 'waiting_user_input')`,
    [input.jobId, terminalStatus, input.nowMs]
  );
  await client.query(
    `update agent_plan_steps step
     set status = $2,
         error_code = $3,
         error_message = $4,
         error_details = $5,
         version = step.version + 1,
         updated_at_ms = $6,
         completed_at_ms = $6
     from agent_plans plan
     where step.plan_id = plan.id
       and plan.job_id = $1
       and step.status in ('pending', 'running', 'waiting_user_input')`,
    [
      input.jobId,
      terminalStatus,
      input.error?.code ?? null,
      input.error?.message ?? null,
      input.error?.details ?? null,
      input.nowMs,
    ]
  );
  await client.query(
    `update agent_step_runs
     set status = $2,
         error_code = $3,
         error_message = $4,
         error_details = $5,
         version = version + 1,
         updated_at_ms = $6,
         completed_at_ms = $6
     where job_id = $1
       and status in ('created', 'running', 'waiting_user_input', 'resuming')`,
    [
      input.jobId,
      terminalStatus,
      input.error?.code ?? null,
      input.error?.message ?? null,
      input.error?.details ?? null,
      input.nowMs,
    ]
  );
  await client.query(
    `update agent_tool_invocations
     set status = case
           when status = 'running' and side_effect_level = 'side_effecting' then 'unknown'
           else 'cancelled'
         end,
         error_code = coalesce(
           error_code,
           case
             when status = 'running' and side_effect_level = 'side_effecting'
               then 'side_effect_status_unknown'
             else $2
           end
         ),
         error_message = coalesce(
           error_message,
           case
             when status = 'running' and side_effect_level = 'side_effecting'
               then 'Side-effecting tool execution lost its owner before the outcome was committed.'
             else $3
           end
         ),
         error_details = coalesce(error_details, $4),
         version = version + 1,
         updated_at_ms = $5
     where job_id = $1
       and status in ('pending', 'running', 'waiting_user_input')`,
    [
      input.jobId,
      input.error?.code ?? (terminalStatus === 'failed' ? 'job_failed' : 'job_cancelled'),
      input.error?.message ?? `Job was ${terminalStatus}.`,
      input.error?.details ?? null,
      input.nowMs,
    ]
  );
  await client.query(
    `update agent_user_input_requests
     set status = 'cancelled', version = version + 1, updated_at_ms = $2
     where job_id = $1 and status = 'pending'`,
    [input.jobId, input.nowMs]
  );
}

async function assertValidRetry(
  client: PoolClient,
  sessionId: string,
  retryOfJobId: string
): Promise<void> {
  const result = await client.query<Pick<AgentJobRow, 'id' | 'session_id' | 'status'>>(
    `select id, session_id, status
     from agent_jobs
     where id = $1
     for update`,
    [retryOfJobId]
  );
  const job = result.rows[0];
  if (!job || job.session_id !== sessionId || job.status !== 'failed') {
    throw new AgentStoreError(
      'INVALID_JOB_RETRY',
      `Retry source ${JSON.stringify(retryOfJobId)} must be a failed Job in the same Session.`,
      { sessionId, retryOfJobId, sourceStatus: job?.status }
    );
  }
}

function mapCreateJobError(
  error: unknown,
  input: CreateJobAndAppendUserMessageInput
): unknown {
  if (isConstraint(error, 'uniq_agent_jobs_active_session')) {
    return new AgentStoreError(
      'ACTIVE_JOB_CONFLICT',
      `Session ${JSON.stringify(input.sessionId)} already has an active Job.`,
      { sessionId: input.sessionId }
    );
  }
  if (isConstraint(error, 'uniq_agent_jobs_client_request')) {
    return new AgentStoreError(
      'CLIENT_REQUEST_CONFLICT',
      `Client request ${JSON.stringify(input.clientRequestId)} was already used in this Session.`,
      { sessionId: input.sessionId, clientRequestId: input.clientRequestId }
    );
  }
  if (isConstraint(error, 'agent_jobs_pkey')) {
    return new AgentStoreError(
      'JOB_ALREADY_EXISTS',
      `Agent Job ${JSON.stringify(input.jobId)} already exists.`,
      { jobId: input.jobId }
    );
  }
  return error;
}

async function throwJobMutationConflict(
  client: PoolClient,
  jobId: string,
  expectedVersion: number,
  operation: string,
  leaseSensitive = false
): Promise<never> {
  const job = await selectJob(client, jobId);
  if (!job) throw jobNotFound(jobId);
  if (job.version !== expectedVersion) {
    throw new AgentStoreError(
      'CONCURRENCY_CONFLICT',
      `Cannot ${operation} Job ${JSON.stringify(jobId)} because version ${expectedVersion} is stale.`,
      { jobId, expectedVersion, actualVersion: job.version }
    );
  }
  throw new AgentStoreError(
    leaseSensitive ? 'JOB_LEASE_LOST' : 'INVALID_JOB_STATE',
    `Cannot ${operation} Job ${JSON.stringify(jobId)} from its current state.`,
    { jobId, status: job.status }
  );
}

function assertExpectedVersion(job: AgentJobRow, expectedVersion: number): void {
  if (job.version !== expectedVersion) {
    throw new AgentStoreError(
      'CONCURRENCY_CONFLICT',
      `Job ${JSON.stringify(job.id)} version ${expectedVersion} is stale.`,
      { jobId: job.id, expectedVersion, actualVersion: job.version }
    );
  }
}

function assertJobLease(
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

function assertFutureLease(nowMs: number, leaseUntilMs: number): void {
  if (leaseUntilMs <= nowMs) {
    throw new RangeError('leaseUntilMs must be greater than nowMs.');
  }
}

async function selectJob(client: PoolClient, jobId: string): Promise<AgentJobRow | undefined> {
  const result = await client.query<AgentJobRow>(
    `select * from agent_jobs where id = $1`,
    [jobId]
  );
  return result.rows[0];
}

async function selectToolInvocation(
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

async function resolveStepRunScope(
  client: PoolClient,
  jobId: string,
  stepRunId: string | undefined
): Promise<{ planId: string; stepId: string } | undefined> {
  if (!stepRunId) return undefined;
  const result = await client.query<{ plan_id: string; step_id: string }>(
    `select plan_id, step_id
     from agent_step_runs
     where id = $1 and job_id = $2`,
    [stepRunId, jobId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AgentStoreError(
      'TOOL_INVOCATION_CONFLICT',
      `StepRun ${JSON.stringify(stepRunId)} does not belong to Job ${JSON.stringify(jobId)}.`,
      { jobId, stepRunId }
    );
  }
  return { planId: row.plan_id, stepId: row.step_id };
}

function jobNotFound(jobId: string): AgentStoreError {
  return new AgentStoreError(
    'JOB_NOT_FOUND',
    `Agent Job ${JSON.stringify(jobId)} was not found.`,
    { jobId }
  );
}

function isConstraint(error: unknown, constraint: string): boolean {
  const pgError = error as PostgresErrorLike;
  return pgError?.code === '23505' && pgError.constraint === constraint;
}

function requireRow<T>(row: T | undefined, operation: string): T {
  if (!row) throw new Error(`PostgreSQL did not return a row for ${operation}.`);
  return row;
}
