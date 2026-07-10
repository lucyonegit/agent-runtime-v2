import type { PoolClient } from 'pg';
import type { AgentJob, AgentMessage, AgentSession } from '../../domain/index.js';
import {
  AgentStoreError,
  type CancelJobInput,
  type ClaimJobInput,
  type ClaimToolInvocationInput,
  type ClaimToolInvocationResult,
  type AnswerInputAndClaimResumeInput,
  type AnswerInputAndClaimResumeResult,
  type CommitModelToolCallsInput,
  type CommitModelToolCallsResult,
  type CommitToolResultInput,
  type CommitToolResultResult,
  type CompleteJobWithFinalMessageInput,
  type CompleteJobWithFinalMessageResult,
  type CreateInputRequestsAndMarkWaitingInput,
  type CreateInputRequestsAndMarkWaitingResult,
  type CreateJobAndAppendUserMessageInput,
  type CreateJobAndAppendUserMessageResult,
  type CreateSessionInput,
  type CreatePlanInput,
  type CreatePlanResult,
  type CreateStepRunInput,
  type CreateStepRunResult,
  type CommitStepOutputInput,
  type CommitStepOutputResult,
  type FailStepRunInput,
  type FailStepRunResult,
  type RouteJobInput,
  type StartModelCallInput,
  type CompleteModelCallInput,
  type CompleteModelCallResult,
  type ReplaceContextSummaryInput,
  type FailJobInput,
  type RenewJobLeaseInput,
} from '../agent-store.js';
import {
  mapAgentJobRow,
  mapAgentMessageRow,
  mapAgentSessionRow,
  mapAgentPlanRow,
  mapAgentPlanStepRow,
  mapAgentStepRunRow,
  mapAgentModelCallRow,
  mapAgentModelUsageStatsRow,
  mapAgentContextSummaryRow,
  mapAgentToolInvocationRow,
  mapAgentUserInputRequestRow,
  type AgentJobRow,
  type AgentMessageRow,
  type AgentSessionRow,
  type AgentPlanRow,
  type AgentPlanStepRow,
  type AgentStepRunRow,
  type AgentModelCallRow,
  type AgentModelUsageStatsRow,
  type AgentContextSummaryRow,
  type AgentToolInvocationRow,
  type AgentUserInputRequestRow,
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
    await touchSession(client, input.sessionId, input.nowMs);
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
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'create tool-result message')),
      invocation: mapAgentToolInvocationRow(
        requireRow(updatedInvocation.rows[0], 'complete tool invocation')
      ),
    };
  });
}

export async function completeJobWithFinalMessageCommand(
  client: PoolClient,
  input: CompleteJobWithFinalMessageInput
): Promise<CompleteJobWithFinalMessageResult> {
  const initialJob = await selectJob(client, input.jobId);
  if (!initialJob || initialJob.session_id !== input.sessionId) throw jobNotFound(input.jobId);
  const messageType = input.messageType ?? 'assistant_message';

  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`,
      [input.jobId]
    );
    const job = requireRow(jobResult.rows[0], 'lock job for final message');
    assertJobLease(job, input.workerId, input.attemptId, input.nowMs);

    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, job_id, attempt_id, output_id,
         role, message_type, visibility, channel, content, created_at_ms
       ) values (
         $1, $2, $3, $4, $5,
         'assistant', $6, 'ui', 'final', $7, $8
       )
       returning *`,
      [
        input.messageId,
        input.sessionId,
        input.jobId,
        input.attemptId,
        input.outputId,
        messageType,
        input.content,
        input.nowMs,
      ]
    );
    const completedJob = await client.query<AgentJobRow>(
      `update agent_jobs
       set strategy = coalesce(strategy, $2),
           stage = case when strategy is null then $3 else stage end,
           status = 'completed',
           lease_owner = null,
           lease_expires_at_ms = null,
           version = version + 1,
           updated_at_ms = $4,
           completed_at_ms = $4
       where id = $1
       returning *`,
      [
        input.jobId,
        messageType === 'plan_final' ? 'planned' : 'direct',
        messageType === 'plan_final' ? 'finalizing' : 'direct_execution',
        input.nowMs,
      ]
    );
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      job: mapAgentJobRow(requireRow(completedJob.rows[0], 'complete job')),
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'create final message')),
    };
  });
}

export async function createInputRequestsAndMarkWaitingCommand(
  client: PoolClient,
  input: CreateInputRequestsAndMarkWaitingInput
): Promise<CreateInputRequestsAndMarkWaitingResult> {
  if (input.requests.length === 0) {
    throw new TypeError('At least one UserInputRequest is required.');
  }
  if (new Set(input.requests.map(request => request.requestId)).size !== input.requests.length) {
    throw new TypeError('UserInputRequest IDs must be unique.');
  }
  for (const request of input.requests) {
    const toolRequestIsValid = request.source !== 'tool'
      || (request.answerMode === 'as_tool_result' && Boolean(request.toolCallId));
    if (!toolRequestIsValid || (request.source !== 'tool' && request.toolCallId)) {
      throw new TypeError('Tool input requests require toolCallId and as_tool_result exclusively.');
    }
  }
  const initialJob = await selectJob(client, input.jobId);
  if (!initialJob || initialJob.session_id !== input.sessionId) throw jobNotFound(input.jobId);

  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`,
      [input.jobId]
    );
    const job = requireRow(jobResult.rows[0], 'lock job for user input');
    assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
    const stepScope = await lockStepRunScope(client, input.jobId, input.stepRunId);
    if (
      stepScope
      && (stepScope.runStatus !== 'running' || stepScope.currentAttemptId !== input.attemptId)
    ) {
      throw new AgentStoreError(
        'INVALID_JOB_STATE',
        `StepRun ${JSON.stringify(input.stepRunId)} is not running in this Job attempt.`
      );
    }

    const toolCallIds = input.requests
      .map(request => request.toolCallId)
      .filter((id): id is string => id !== undefined)
      .sort();
    const invocationRows = toolCallIds.length === 0
      ? []
      : (await client.query<AgentToolInvocationRow>(
          `select *
           from agent_tool_invocations
           where job_id = $1 and tool_call_id = any($2::text[])
           order by id
           for update`,
          [input.jobId, toolCallIds]
        )).rows;
    const invocationsByToolCall = new Map(
      invocationRows.map(invocation => [invocation.tool_call_id, invocation])
    );
    for (const toolCallId of toolCallIds) {
      const invocation = invocationsByToolCall.get(toolCallId);
      if (
        !invocation
        || invocation.status !== 'running'
        || invocation.attempt_id !== input.attemptId
        || invocation.step_run_id !== (input.stepRunId ?? null)
      ) {
        throw new AgentStoreError(
          'INVALID_TOOL_INVOCATION_STATE',
          `Tool invocation ${JSON.stringify(toolCallId)} cannot wait for input.`,
          { jobId: input.jobId, toolCallId, status: invocation?.status }
        );
      }
    }

    const requestRows: AgentUserInputRequestRow[] = [];
    const updatedInvocationRows: AgentToolInvocationRow[] = [];
    for (const request of input.requests) {
      const invocation = request.toolCallId
        ? invocationsByToolCall.get(request.toolCallId)
        : undefined;
      const requestResult = await client.query<AgentUserInputRequestRow>(
        `insert into agent_user_input_requests(
           id, session_id, job_id, plan_id, step_id, step_run_id, tool_invocation_id,
           source, answer_mode, status, title, prompt, input_schema,
           version, metadata, created_at_ms, updated_at_ms
         ) values (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, 'pending', $10, $11, $12,
           0, $13, $14, $14
         )
         returning *`,
        [
          request.requestId,
          input.sessionId,
          input.jobId,
          stepScope?.planId ?? null,
          stepScope?.stepId ?? null,
          input.stepRunId ?? null,
          invocation?.id ?? null,
          request.source,
          request.answerMode,
          request.title ?? null,
          request.prompt,
          JSON.stringify(request.inputSchema),
          request.metadata ?? null,
          input.nowMs,
        ]
      );
      requestRows.push(requireRow(requestResult.rows[0], 'create user input request'));
      if (invocation) {
        const updatedInvocation = await client.query<AgentToolInvocationRow>(
          `update agent_tool_invocations
           set status = 'waiting_user_input', version = version + 1, updated_at_ms = $2
           where id = $1
           returning *`,
          [invocation.id, input.nowMs]
        );
        updatedInvocationRows.push(
          requireRow(updatedInvocation.rows[0], 'mark tool invocation waiting')
        );
      }
    }

    if (stepScope) {
      await client.query(
        `update agent_step_runs
         set status = 'waiting_user_input', version = version + 1, updated_at_ms = $2
         where id = $1`,
        [input.stepRunId, input.nowMs]
      );
      await client.query(
        `update agent_plan_steps
         set status = 'waiting_user_input', version = version + 1, updated_at_ms = $2
         where id = $1`,
        [stepScope.stepId, input.nowMs]
      );
      await client.query(
        `update agent_plans
         set status = 'waiting_user_input', version = version + 1, updated_at_ms = $2
         where id = $1`,
        [stepScope.planId, input.nowMs]
      );
    }
    const waitingJob = await client.query<AgentJobRow>(
      `update agent_jobs
       set status = 'waiting_user_input',
           lease_owner = null,
           lease_expires_at_ms = null,
           version = version + 1,
           updated_at_ms = $2
       where id = $1
       returning *`,
      [input.jobId, input.nowMs]
    );
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      job: mapAgentJobRow(requireRow(waitingJob.rows[0], 'mark job waiting')),
      requests: requestRows.map(mapAgentUserInputRequestRow),
      invocations: updatedInvocationRows.map(mapAgentToolInvocationRow),
    };
  });
}

export async function answerInputAndClaimResumeCommand(
  client: PoolClient,
  input: AnswerInputAndClaimResumeInput
): Promise<AnswerInputAndClaimResumeResult> {
  assertFutureLease(input.nowMs, input.leaseUntilMs);
  if (!input.clientAnswerId.trim()) throw new TypeError('clientAnswerId must not be empty.');
  if (input.answer === undefined) throw new TypeError('answer must be defined.');
  const initialRequest = await selectUserInputRequest(client, input.requestId);
  if (!initialRequest) throw userInputNotFound(input.requestId);

  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, initialRequest.session_id);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`,
      [initialRequest.job_id]
    );
    let job = requireRow(jobResult.rows[0], 'lock job for input answer');
    const stepScope = await lockStepRunScope(
      client,
      initialRequest.job_id,
      initialRequest.step_run_id ?? undefined
    );
    const invocationResult = initialRequest.tool_invocation_id
      ? await client.query<AgentToolInvocationRow>(
          `select * from agent_tool_invocations where id = $1 for update`,
          [initialRequest.tool_invocation_id]
        )
      : undefined;
    let invocation = invocationResult?.rows[0];
    const requestResult = await client.query<AgentUserInputRequestRow>(
      `select * from agent_user_input_requests where id = $1 for update`,
      [input.requestId]
    );
    let request = requireRow(requestResult.rows[0], 'lock user input request');

    if (request.status === 'answered') {
      if (request.client_answer_id !== input.clientAnswerId || !request.answer_message_id) {
        throw new AgentStoreError(
          'USER_INPUT_ANSWER_CONFLICT',
          `User input request ${JSON.stringify(input.requestId)} was already answered.`,
          { requestId: input.requestId }
        );
      }
      const answerMessage = await selectMessageById(client, request.answer_message_id);
      return {
        request: mapAgentUserInputRequestRow(request),
        answerMessage: mapAgentMessageRow(requireRow(answerMessage, 'load idempotent answer message')),
        job: mapAgentJobRow(job),
        ...(invocation ? { invocation: mapAgentToolInvocationRow(invocation) } : {}),
        shouldResume: false,
      };
    }
    if (request.status !== 'pending') {
      throw new AgentStoreError(
        'INVALID_USER_INPUT_STATE',
        `User input request ${JSON.stringify(input.requestId)} is ${request.status}.`,
        { requestId: input.requestId, status: request.status }
      );
    }
    if (request.version !== input.expectedVersion) {
      throw new AgentStoreError(
        'CONCURRENCY_CONFLICT',
        `User input request ${JSON.stringify(input.requestId)} version is stale.`,
        { requestId: input.requestId, expectedVersion: input.expectedVersion, actualVersion: request.version }
      );
    }
    const reusedClientAnswer = await client.query<{ id: string }>(
      `select id
       from agent_user_input_requests
       where job_id = $1 and client_answer_id = $2 and id <> $3`,
      [request.job_id, input.clientAnswerId, request.id]
    );
    if (reusedClientAnswer.rows[0]) {
      throw new AgentStoreError(
        'USER_INPUT_ANSWER_CONFLICT',
        `clientAnswerId ${JSON.stringify(input.clientAnswerId)} was used for another request.`,
        { requestId: input.requestId, conflictingRequestId: reusedClientAnswer.rows[0].id }
      );
    }
    if (job.status !== 'waiting_user_input') {
      throw new AgentStoreError(
        'INVALID_JOB_STATE',
        `Job ${JSON.stringify(job.id)} is not waiting for user input.`,
        { jobId: job.id, status: job.status }
      );
    }

    const isToolAnswer = request.source === 'tool';
    if (isToolAnswer && (!invocation || invocation.status !== 'waiting_user_input')) {
      throw new AgentStoreError(
        'INVALID_TOOL_INVOCATION_STATE',
        'Tool input request is not paired with a waiting ToolInvocation.'
      );
    }
    const answerJson = JSON.stringify(input.answer);
    const answerContent = typeof input.answer === 'string' ? input.answer : answerJson;
    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, job_id, plan_id, step_id, step_run_id, attempt_id,
         role, message_type, visibility, channel, content,
         tool_call_id, tool_name, tool_result, created_at_ms
       ) values (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, 'ui', 'normal', $10,
         $11, $12, $13, $14
       )
       returning *`,
      [
        input.answerMessageId,
        request.session_id,
        request.job_id,
        request.plan_id,
        request.step_id,
        request.step_run_id,
        job.current_attempt_id,
        isToolAnswer ? 'tool' : 'user',
        isToolAnswer ? 'tool_result' : 'user_message',
        answerContent,
        invocation?.tool_call_id ?? null,
        invocation?.tool_name ?? null,
        isToolAnswer
          ? JSON.stringify({ status: 'completed', result: input.answer, durationMs: 0 })
          : null,
        input.nowMs,
      ]
    );
    const answerMessage = requireRow(messageResult.rows[0], 'create input answer message');
    if (invocation) {
      const invocationUpdate = await client.query<AgentToolInvocationRow>(
        `update agent_tool_invocations
         set status = 'completed',
             result_message_id = $2,
             result_payload = $3,
             version = version + 1,
             completed_at_ms = $4,
             updated_at_ms = $4
         where id = $1
         returning *`,
        [invocation.id, input.answerMessageId, answerJson, input.nowMs]
      );
      invocation = requireRow(invocationUpdate.rows[0], 'complete input tool invocation');
    }
    const requestUpdate = await client.query<AgentUserInputRequestRow>(
      `update agent_user_input_requests
       set status = 'answered',
           answer = $2,
           answer_message_id = $3,
           client_answer_id = $4,
           version = version + 1,
           updated_at_ms = $5,
           answered_at_ms = $5
       where id = $1
       returning *`,
      [input.requestId, answerJson, input.answerMessageId, input.clientAnswerId, input.nowMs]
    );
    request = requireRow(requestUpdate.rows[0], 'answer user input request');

    const pending = await client.query<{ count: string }>(
      `select count(*)::text as count
       from agent_user_input_requests
       where job_id = $1 and status = 'pending'`,
      [job.id]
    );
    const shouldResume = pending.rows[0]?.count === '0';
    if (shouldResume) {
      const resumedJob = await client.query<AgentJobRow>(
        `update agent_jobs
         set status = 'resuming',
             lease_owner = $2,
             lease_expires_at_ms = $3,
             current_attempt_id = $4,
             attempt_no = attempt_no + 1,
             version = version + 1,
             updated_at_ms = $5
         where id = $1 and status = 'waiting_user_input'
         returning *`,
        [job.id, input.workerId, input.leaseUntilMs, input.attemptId, input.nowMs]
      );
      job = requireRow(resumedJob.rows[0], 'claim resumed job');
      if (stepScope) {
        await client.query(
          `update agent_step_runs
           set status = 'resuming', current_attempt_id = $2,
               attempt_no = attempt_no + 1, version = version + 1, updated_at_ms = $3
           where id = $1 and status = 'waiting_user_input'`,
          [request.step_run_id, input.attemptId, input.nowMs]
        );
        await client.query(
          `update agent_plan_steps
           set status = 'running', version = version + 1, updated_at_ms = $2
           where id = $1 and status = 'waiting_user_input'`,
          [stepScope.stepId, input.nowMs]
        );
        await client.query(
          `update agent_plans
           set status = 'active', version = version + 1, updated_at_ms = $2
           where id = $1 and status = 'waiting_user_input'`,
          [stepScope.planId, input.nowMs]
        );
      }
    }
    await touchSession(client, request.session_id, input.nowMs);
    return {
      request: mapAgentUserInputRequestRow(request),
      answerMessage: mapAgentMessageRow(answerMessage),
      job: mapAgentJobRow(job),
      ...(invocation ? { invocation: mapAgentToolInvocationRow(invocation) } : {}),
      shouldResume,
      ...(shouldResume ? { attemptId: input.attemptId } : {}),
    };
  });
}

export async function routeJobCommand(
  client: PoolClient,
  input: RouteJobInput
): Promise<AgentJob> {
  const result = await client.query<AgentJobRow>(
    `update agent_jobs
     set strategy = $2,
         stage = $3,
         version = version + 1,
         updated_at_ms = $6
     where id = $1
       and status in ('running', 'resuming')
       and lease_owner = $4
       and current_attempt_id = $5
       and lease_expires_at_ms > $6
     returning *`,
    [
      input.jobId,
      input.strategy,
      input.strategy === 'direct' ? 'direct_execution' : 'planning',
      input.workerId,
      input.attemptId,
      input.nowMs,
    ]
  );
  if (result.rows[0]) return mapAgentJobRow(result.rows[0]);
  const job = await selectJob(client, input.jobId);
  if (!job) throw jobNotFound(input.jobId);
  assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
  throw new AgentStoreError(
    'INVALID_JOB_STATE',
    `Job ${JSON.stringify(input.jobId)} cannot be routed from status ${job.status}.`
  );
}

export async function createPlanCommand(
  client: PoolClient,
  input: CreatePlanInput
): Promise<CreatePlanResult> {
  if (input.steps.length === 0) throw new TypeError('A Plan requires at least one step.');
  if (new Set(input.steps.map(step => step.id)).size !== input.steps.length) {
    throw new TypeError('PlanStep IDs must be unique.');
  }
  const initialJob = await selectJob(client, input.jobId);
  if (!initialJob || initialJob.session_id !== input.sessionId) throw jobNotFound(input.jobId);
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`,
      [input.jobId]
    );
    const job = requireRow(jobResult.rows[0], 'lock job for plan creation');
    assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
    if (job.strategy !== 'planned' || job.stage !== 'planning') {
      throw new AgentStoreError(
        'INVALID_JOB_STATE',
        `Job ${JSON.stringify(job.id)} is not in planned planning stage.`
      );
    }
    const planResult = await client.query<AgentPlanRow>(
      `insert into agent_plans(
         id, session_id, job_id, title, goal, status, version, metadata,
         created_at_ms, updated_at_ms
       ) values ($1, $2, $3, $4, $5, 'active', 0, $6, $7, $7)
       returning *`,
      [
        input.planId,
        input.sessionId,
        input.jobId,
        input.title,
        input.goal,
        input.metadata ?? null,
        input.nowMs,
      ]
    );
    const stepRows: AgentPlanStepRow[] = [];
    for (const [position, step] of input.steps.entries()) {
      const stepResult = await client.query<AgentPlanStepRow>(
        `insert into agent_plan_steps(
           id, plan_id, position, title, instruction, status, version, metadata,
           created_at_ms, updated_at_ms
         ) values ($1, $2, $3, $4, $5, 'pending', 0, $6, $7, $7)
         returning *`,
        [step.id, input.planId, position, step.title, step.instruction, step.metadata ?? null, input.nowMs]
      );
      stepRows.push(requireRow(stepResult.rows[0], 'create plan step'));
    }
    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, job_id, plan_id, attempt_id,
         role, message_type, visibility, channel, content, metadata, created_at_ms
       ) values (
         $1, $2, $3, $4, $5,
         'assistant', 'plan_created', 'ui', 'normal', $6, $7, $8
       ) returning *`,
      [
        input.messageId,
        input.sessionId,
        input.jobId,
        input.planId,
        input.attemptId,
        input.title,
        JSON.stringify({ goal: input.goal, steps: input.steps }),
        input.nowMs,
      ]
    );
    const updatedJob = await client.query<AgentJobRow>(
      `update agent_jobs
       set stage = 'step_execution', version = version + 1, updated_at_ms = $2
       where id = $1 returning *`,
      [input.jobId, input.nowMs]
    );
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      job: mapAgentJobRow(requireRow(updatedJob.rows[0], 'advance job to step execution')),
      plan: mapAgentPlanRow(requireRow(planResult.rows[0], 'create plan')),
      steps: stepRows.map(mapAgentPlanStepRow),
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'create plan message')),
    };
  });
}

export async function createStepRunCommand(
  client: PoolClient,
  input: CreateStepRunInput
): Promise<CreateStepRunResult> {
  if (!Number.isSafeInteger(input.maxRunsPerStep) || input.maxRunsPerStep < 1) {
    throw new RangeError('maxRunsPerStep must be a positive safe integer.');
  }
  const initialJob = await selectJob(client, input.jobId);
  if (!initialJob || initialJob.session_id !== input.sessionId) throw jobNotFound(input.jobId);
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`,
      [input.jobId]
    );
    const job = requireRow(jobResult.rows[0], 'lock job for step run');
    assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
    if (job.strategy !== 'planned' || job.stage !== 'step_execution') {
      throw new AgentStoreError('INVALID_JOB_STATE', 'Job is not ready for StepRun execution.');
    }
    const planResult = await client.query<AgentPlanRow>(
      `select * from agent_plans where id = $1 and job_id = $2 for update`,
      [input.planId, input.jobId]
    );
    const plan = planResult.rows[0];
    if (!plan) throw new AgentStoreError('PLAN_NOT_FOUND', `Plan ${input.planId} was not found.`);
    if (plan.status !== 'active') {
      throw new AgentStoreError('INVALID_PLAN_STATE', `Plan ${input.planId} is ${plan.status}.`);
    }
    const stepResult = await client.query<AgentPlanStepRow>(
      `select * from agent_plan_steps where id = $1 and plan_id = $2 for update`,
      [input.stepId, input.planId]
    );
    const step = stepResult.rows[0];
    if (!step) throw new AgentStoreError('PLAN_STEP_NOT_FOUND', `PlanStep ${input.stepId} was not found.`);
    if (step.status !== 'pending') {
      throw new AgentStoreError('INVALID_PLAN_STATE', `PlanStep ${input.stepId} is ${step.status}.`);
    }
    const previousRuns = await client.query<{ run_no: number; status: string }>(
      `select run_no, status
       from agent_step_runs
       where step_id = $1
       order by run_no desc
       for update`,
      [input.stepId]
    );
    const nextRunNo = (previousRuns.rows[0]?.run_no ?? 0) + 1;
    if (nextRunNo > input.maxRunsPerStep) {
      throw new AgentStoreError(
        'INVALID_STEP_RUN_STATE',
        `PlanStep ${input.stepId} exceeded max run count ${input.maxRunsPerStep}.`
      );
    }
    if (previousRuns.rows[0] && previousRuns.rows[0].status !== 'failed') {
      throw new AgentStoreError(
        'INVALID_STEP_RUN_STATE',
        'A new StepRun requires the previous run to be failed.'
      );
    }
    const runResult = await client.query<AgentStepRunRow>(
      `insert into agent_step_runs(
         id, session_id, job_id, plan_id, step_id, run_no,
         executor, status, current_attempt_id, attempt_no, version,
         created_at_ms, updated_at_ms, started_at_ms
       ) values (
         $1, $2, $3, $4, $5, $6,
         $7, 'running', $8, 1, 0,
         $9, $9, $9
       ) returning *`,
      [
        input.stepRunId,
        input.sessionId,
        input.jobId,
        input.planId,
        input.stepId,
        nextRunNo,
        input.executor,
        input.attemptId,
        input.nowMs,
      ]
    );
    const updatedStep = await client.query<AgentPlanStepRow>(
      `update agent_plan_steps
       set status = 'running', version = version + 1, updated_at_ms = $2
       where id = $1 returning *`,
      [input.stepId, input.nowMs]
    );
    const updatedJob = await client.query<AgentJobRow>(
      `update agent_jobs
       set stage = 'step_execution', version = version + 1, updated_at_ms = $2
       where id = $1 returning *`,
      [input.jobId, input.nowMs]
    );
    return {
      job: mapAgentJobRow(requireRow(updatedJob.rows[0], 'update job for step run')),
      plan: mapAgentPlanRow(plan),
      step: mapAgentPlanStepRow(requireRow(updatedStep.rows[0], 'start plan step')),
      stepRun: mapAgentStepRunRow(requireRow(runResult.rows[0], 'create step run')),
    };
  });
}

export async function commitStepOutputCommand(
  client: PoolClient,
  input: CommitStepOutputInput
): Promise<CommitStepOutputResult> {
  const initialRun = await selectStepRun(client, input.stepRunId);
  if (!initialRun || initialRun.job_id !== input.jobId || initialRun.session_id !== input.sessionId) {
    throw new AgentStoreError('STEP_RUN_NOT_FOUND', `StepRun ${input.stepRunId} was not found.`);
  }
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`, [input.jobId]
    );
    const job = requireRow(jobResult.rows[0], 'lock job for step output');
    assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
    const planResult = await client.query<AgentPlanRow>(
      `select * from agent_plans where id = $1 for update`, [initialRun.plan_id]
    );
    const stepResult = await client.query<AgentPlanStepRow>(
      `select * from agent_plan_steps where id = $1 for update`, [initialRun.step_id]
    );
    const runResult = await client.query<AgentStepRunRow>(
      `select * from agent_step_runs where id = $1 for update`, [input.stepRunId]
    );
    const plan = requireRow(planResult.rows[0], 'lock plan for step output');
    const step = requireRow(stepResult.rows[0], 'lock step for output');
    const run = requireRow(runResult.rows[0], 'lock step run for output');
    if (
      !['running', 'resuming'].includes(run.status)
      || run.current_attempt_id !== input.attemptId
      || step.status !== 'running'
      || plan.status !== 'active'
    ) {
      throw new AgentStoreError('INVALID_STEP_RUN_STATE', 'StepRun is not active in this attempt.');
    }
    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, job_id, plan_id, step_id, step_run_id,
         attempt_id, output_id, role, message_type, visibility, channel,
         content, metadata, created_at_ms
       ) values (
         $1, $2, $3, $4, $5, $6,
         $7, $8, 'assistant', 'step_output', 'ui', 'final',
         $9, $10, $11
       ) returning *`,
      [
        input.messageId,
        input.sessionId,
        input.jobId,
        run.plan_id,
        run.step_id,
        run.id,
        input.attemptId,
        input.outputId,
        input.content,
        JSON.stringify({ structuredOutput: input.structuredOutput }),
        input.nowMs,
      ]
    );
    const updatedRun = await client.query<AgentStepRunRow>(
      `update agent_step_runs
       set status = 'completed', output_message_id = $2,
           version = version + 1, updated_at_ms = $3, completed_at_ms = $3
       where id = $1 returning *`,
      [run.id, input.messageId, input.nowMs]
    );
    const updatedStep = await client.query<AgentPlanStepRow>(
      `update agent_plan_steps
       set status = 'completed', output_message_id = $2,
           version = version + 1, updated_at_ms = $3, completed_at_ms = $3
       where id = $1 returning *`,
      [step.id, input.messageId, input.nowMs]
    );
    const remaining = await client.query<{ count: string }>(
      `select count(*)::text as count
       from agent_plan_steps
       where plan_id = $1 and status <> 'completed'`,
      [plan.id]
    );
    const hasPendingSteps = remaining.rows[0]?.count !== '0';
    let finalPlan: AgentPlanRow;
    if (hasPendingSteps) {
      finalPlan = plan;
    } else {
      const completedPlan = await client.query<AgentPlanRow>(
        `update agent_plans
         set status = 'completed', version = version + 1,
             updated_at_ms = $2, completed_at_ms = $2
         where id = $1 returning *`,
        [plan.id, input.nowMs]
      );
      finalPlan = requireRow(completedPlan.rows[0], 'complete plan');
    }
    const updatedJob = await client.query<AgentJobRow>(
      `update agent_jobs
       set stage = $2, version = version + 1, updated_at_ms = $3
       where id = $1 returning *`,
      [input.jobId, hasPendingSteps ? 'step_execution' : 'finalizing', input.nowMs]
    );
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      job: mapAgentJobRow(requireRow(updatedJob.rows[0], 'advance job after step output')),
      plan: mapAgentPlanRow(finalPlan),
      step: mapAgentPlanStepRow(requireRow(updatedStep.rows[0], 'complete plan step')),
      stepRun: mapAgentStepRunRow(requireRow(updatedRun.rows[0], 'complete step run')),
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'create step output message')),
      hasPendingSteps,
    };
  });
}

export async function failStepRunCommand(
  client: PoolClient,
  input: FailStepRunInput
): Promise<FailStepRunResult> {
  const initialRun = await selectStepRun(client, input.stepRunId);
  if (!initialRun || initialRun.job_id !== input.jobId || initialRun.session_id !== input.sessionId) {
    throw new AgentStoreError('STEP_RUN_NOT_FOUND', `StepRun ${input.stepRunId} was not found.`);
  }
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`, [input.jobId]
    );
    let job = requireRow(jobResult.rows[0], 'lock job for step failure');
    assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
    const planResult = await client.query<AgentPlanRow>(
      `select * from agent_plans where id = $1 for update`, [initialRun.plan_id]
    );
    const stepResult = await client.query<AgentPlanStepRow>(
      `select * from agent_plan_steps where id = $1 for update`, [initialRun.step_id]
    );
    const runResult = await client.query<AgentStepRunRow>(
      `select * from agent_step_runs where id = $1 for update`, [input.stepRunId]
    );
    let plan = requireRow(planResult.rows[0], 'lock plan for step failure');
    let step = requireRow(stepResult.rows[0], 'lock step for failure');
    const run = requireRow(runResult.rows[0], 'lock step run for failure');
    if (!['running', 'resuming'].includes(run.status) || run.current_attempt_id !== input.attemptId) {
      throw new AgentStoreError('INVALID_STEP_RUN_STATE', 'StepRun is not active in this attempt.');
    }
    const failedRunResult = await client.query<AgentStepRunRow>(
      `update agent_step_runs
       set status = 'failed', error_code = $2, error_message = $3, error_details = $4,
           version = version + 1, updated_at_ms = $5, completed_at_ms = $5
       where id = $1 returning *`,
      [run.id, input.error.code, input.error.message, input.error.details ?? null, input.nowMs]
    );
    if (input.retryStep) {
      const resetStep = await client.query<AgentPlanStepRow>(
        `update agent_plan_steps
         set status = 'pending', error_code = $2, error_message = $3, error_details = $4,
             version = version + 1, updated_at_ms = $5, completed_at_ms = null
         where id = $1 returning *`,
        [step.id, input.error.code, input.error.message, input.error.details ?? null, input.nowMs]
      );
      step = requireRow(resetStep.rows[0], 'reset failed step for retry');
      const retryJob = await client.query<AgentJobRow>(
        `update agent_jobs
         set stage = 'step_execution', version = version + 1, updated_at_ms = $2
         where id = $1 returning *`,
        [job.id, input.nowMs]
      );
      job = requireRow(retryJob.rows[0], 'keep job active for step retry');
    } else {
      const failedStep = await client.query<AgentPlanStepRow>(
        `update agent_plan_steps
         set status = 'failed', error_code = $2, error_message = $3, error_details = $4,
             version = version + 1, updated_at_ms = $5, completed_at_ms = $5
         where id = $1 returning *`,
        [step.id, input.error.code, input.error.message, input.error.details ?? null, input.nowMs]
      );
      step = requireRow(failedStep.rows[0], 'fail plan step');
      const failedPlan = await client.query<AgentPlanRow>(
        `update agent_plans
         set status = 'failed', version = version + 1,
             updated_at_ms = $2, completed_at_ms = $2
         where id = $1 returning *`,
        [plan.id, input.nowMs]
      );
      plan = requireRow(failedPlan.rows[0], 'fail plan');
      const failedJob = await client.query<AgentJobRow>(
        `update agent_jobs
         set status = 'failed', lease_owner = null, lease_expires_at_ms = null,
             error_code = $2, error_message = $3, error_details = $4,
             version = version + 1, updated_at_ms = $5, completed_at_ms = $5
         where id = $1 returning *`,
        [job.id, input.error.code, input.error.message, input.error.details ?? null, input.nowMs]
      );
      job = requireRow(failedJob.rows[0], 'fail job after step failure');
    }
    return {
      job: mapAgentJobRow(job),
      plan: mapAgentPlanRow(plan),
      step: mapAgentPlanStepRow(step),
      stepRun: mapAgentStepRunRow(requireRow(failedRunResult.rows[0], 'fail step run')),
    };
  });
}

export async function startModelCallCommand(
  client: PoolClient,
  input: StartModelCallInput
) {
  const job = await selectJob(client, input.jobId);
  if (!job || job.session_id !== input.sessionId) throw jobNotFound(input.jobId);
  assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
  if (input.stepRunId) {
    const run = await selectStepRun(client, input.stepRunId);
    if (!run || run.job_id !== input.jobId || run.current_attempt_id !== input.attemptId) {
      throw new AgentStoreError('STEP_RUN_NOT_FOUND', 'ModelCall StepRun scope mismatch.');
    }
  }
  const result = await client.query<AgentModelCallRow>(
    `insert into agent_model_calls(
       id, session_id, job_id, step_run_id, attempt_id,
       logical_call_key, call_attempt_no, call_type, status,
       provider, model, context_rules_version, input_manifest, input_checksum,
       max_context_tokens, reserved_output_tokens, estimated_input_tokens,
       usage_source, metadata, created_at_ms
     ) values (
       $1, $2, $3, $4, $5,
       $6, $7, $8, 'started',
       $9, $10, $11, $12, $13,
       $14, $15, $16,
       'estimated', $17, $18
     ) returning *`,
    [
      input.id, input.sessionId, input.jobId, input.stepRunId ?? null, input.attemptId,
      input.logicalCallKey, input.callAttemptNo, input.callType,
      input.provider, input.model, input.contextRulesVersion,
      JSON.stringify(input.inputManifest), input.inputChecksum,
      input.maxContextTokens, input.reservedOutputTokens, input.estimatedInputTokens,
      input.metadata ?? null, input.nowMs,
    ]
  );
  return mapAgentModelCallRow(requireRow(result.rows[0], 'start model call'));
}

export async function completeModelCallCommand(
  client: PoolClient,
  input: CompleteModelCallInput
): Promise<CompleteModelCallResult> {
  return withPostgresTransaction(client, async () => {
    const callResult = await client.query<AgentModelCallRow>(
      `select * from agent_model_calls where id = $1 for update`, [input.id]
    );
    const call = requireRow(callResult.rows[0], 'lock model call');
    if (call.status !== 'started') {
      throw new AgentStoreError('CONCURRENCY_CONFLICT', `ModelCall ${input.id} is already ${call.status}.`);
    }
    const updated = await client.query<AgentModelCallRow>(
      `update agent_model_calls
       set status = $2,
           actual_input_tokens = $3,
           actual_output_tokens = $4,
           actual_total_tokens = $5,
           cache_read_input_tokens = $6,
           cache_write_input_tokens = $7,
           usage_source = $8,
           output_id = $9,
           result_type = $10,
           result_payload = $11,
           tool_names = $12,
           error_code = $13,
           error_message = $14,
           error_details = $15,
           completed_at_ms = $16
       where id = $1 returning *`,
      [
        input.id, input.status,
        input.actualInputTokens ?? null, input.actualOutputTokens ?? null,
        input.actualTotalTokens ?? null, input.cacheReadInputTokens ?? null,
        input.cacheWriteInputTokens ?? null, input.usageSource,
        input.outputId ?? null, input.resultType ?? null,
        input.resultPayload === undefined ? null : JSON.stringify(input.resultPayload),
        input.toolNames ? JSON.stringify(input.toolNames) : null,
        input.errorCode ?? null, input.errorMessage ?? null,
        input.errorDetails === undefined ? null : JSON.stringify(input.errorDetails),
        input.nowMs,
      ]
    );
    const stats = await upsertModelUsageStats(client, call, input);
    return {
      call: mapAgentModelCallRow(requireRow(updated.rows[0], 'complete model call')),
      usage: mapAgentModelUsageStatsRow(stats),
    };
  });
}

export async function abandonStartedModelCallsCommand(
  client: PoolClient,
  nowMs: number
) {
  return withPostgresTransaction(client, async () => {
    const started = await client.query<AgentModelCallRow>(
      `select * from agent_model_calls where status = 'started' order by id for update`
    );
    const completed: AgentModelCallRow[] = [];
    for (const call of started.rows) {
      const result = await client.query<AgentModelCallRow>(
        `update agent_model_calls
         set status = 'failed', usage_source = 'unavailable',
             error_code = 'model_call_abandoned',
             error_message = 'Model call owner exited before committing a result.',
             completed_at_ms = $2
         where id = $1 returning *`,
        [call.id, nowMs]
      );
      const row = requireRow(result.rows[0], 'abandon model call');
      completed.push(row);
      await upsertModelUsageStats(client, call, {
        id: call.id,
        status: 'failed',
        usageSource: 'unavailable',
        errorCode: 'model_call_abandoned',
        errorMessage: 'Model call owner exited before committing a result.',
        nowMs,
      });
    }
    return completed.map(mapAgentModelCallRow);
  });
}

export async function replaceContextSummaryCommand(
  client: PoolClient,
  input: ReplaceContextSummaryInput
) {
  return withPostgresTransaction(client, async () => {
    const active = await client.query<AgentContextSummaryRow>(
      `select * from agent_context_summaries
       where owner_type = $1 and owner_id = $2 and purpose = $3
         and context_rules_version = $4 and summary_type = $5 and status = 'active'
       for update`,
      [input.ownerType, input.ownerId, input.purpose, input.contextRulesVersion, input.summaryType]
    );
    const replaced = active.rows[0];
    if (replaced) {
      await client.query(
        `update agent_context_summaries
         set status = 'superseded', version = version + 1, updated_at_ms = $2
         where id = $1`,
        [replaced.id, input.nowMs]
      );
    }
    const result = await client.query<AgentContextSummaryRow>(
      `insert into agent_context_summaries(
         id, session_id, job_id, step_run_id, project_id,
         owner_type, owner_id, purpose, context_rules_version, summary_type, status,
         source_row_id_start, source_row_id_end, parent_summary_id, replaces_summary_id,
         summary, summary_format, source_message_count, source_token_count,
         summary_token_count, model, compression_prompt_version, checksum,
         version, metadata, created_at_ms, updated_at_ms
       ) values (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10, 'active',
         $11, $12, $13, $14,
         $15, $16, $17, $18,
         $19, $20, $21, $22,
         0, $23, $24, $24
       ) returning *`,
      [
        input.id, input.sessionId, input.jobId ?? null, input.stepRunId ?? null,
        input.projectId ?? null, input.ownerType, input.ownerId, input.purpose,
        input.contextRulesVersion, input.summaryType,
        input.sourceRowIdStart, input.sourceRowIdEnd, input.parentSummaryId ?? null,
        replaced?.id ?? null, input.summary, input.summaryFormat,
        input.sourceMessageCount, input.sourceTokenCount ?? null,
        input.summaryTokenCount ?? null, input.model ?? null,
        input.compressionPromptVersion, input.checksum, input.metadata ?? null, input.nowMs,
      ]
    );
    return mapAgentContextSummaryRow(requireRow(result.rows[0], 'replace context summary'));
  });
}

async function upsertModelUsageStats(
  client: PoolClient,
  call: AgentModelCallRow,
  input: CompleteModelCallInput
): Promise<AgentModelUsageStatsRow> {
  const actualInput = input.actualInputTokens ?? 0;
  const actualOutput = input.actualOutputTokens ?? 0;
  const total = input.actualTotalTokens ?? (actualInput + actualOutput);
  const ratio = (input.actualInputTokens ?? call.estimated_input_tokens) / call.max_context_tokens;
  const warning = ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'high' : 'normal';
  const result = await client.query<AgentModelUsageStatsRow>(
    `insert into agent_model_usage_stats(
       session_id, total_model_calls, total_estimated_input_tokens,
       total_actual_input_tokens, total_actual_output_tokens,
       total_cache_read_input_tokens, total_cache_write_input_tokens,
       total_tokens, latest_model_call_id, latest_model,
       latest_context_usage_ratio, max_context_tokens, warning_level,
       version, updated_at_ms
     ) values ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13)
     on conflict (session_id) do update set
       total_model_calls = agent_model_usage_stats.total_model_calls + 1,
       total_estimated_input_tokens = agent_model_usage_stats.total_estimated_input_tokens + excluded.total_estimated_input_tokens,
       total_actual_input_tokens = agent_model_usage_stats.total_actual_input_tokens + excluded.total_actual_input_tokens,
       total_actual_output_tokens = agent_model_usage_stats.total_actual_output_tokens + excluded.total_actual_output_tokens,
       total_cache_read_input_tokens = agent_model_usage_stats.total_cache_read_input_tokens + excluded.total_cache_read_input_tokens,
       total_cache_write_input_tokens = agent_model_usage_stats.total_cache_write_input_tokens + excluded.total_cache_write_input_tokens,
       total_tokens = agent_model_usage_stats.total_tokens + excluded.total_tokens,
       latest_model_call_id = excluded.latest_model_call_id,
       latest_model = excluded.latest_model,
       latest_context_usage_ratio = excluded.latest_context_usage_ratio,
       max_context_tokens = excluded.max_context_tokens,
       warning_level = excluded.warning_level,
       version = agent_model_usage_stats.version + 1,
       updated_at_ms = excluded.updated_at_ms
     returning *`,
    [
      call.session_id, call.estimated_input_tokens, actualInput, actualOutput,
      input.cacheReadInputTokens ?? 0, input.cacheWriteInputTokens ?? 0,
      total, call.id, call.model, ratio, call.max_context_tokens, warning, input.nowMs,
    ]
  );
  return requireRow(result.rows[0], 'update model usage stats');
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

async function selectStepRun(
  client: PoolClient,
  stepRunId: string
): Promise<AgentStepRunRow | undefined> {
  const result = await client.query<AgentStepRunRow>(
    `select * from agent_step_runs where id = $1`,
    [stepRunId]
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

async function lockStepRunScope(
  client: PoolClient,
  jobId: string,
  stepRunId: string | undefined
): Promise<{
  planId: string;
  stepId: string;
  runStatus: string;
  currentAttemptId: string | null;
} | undefined> {
  if (!stepRunId) return undefined;
  const scope = await client.query<{
    plan_id: string;
    step_id: string;
    status: string;
    current_attempt_id: string | null;
  }>(
    `select plan_id, step_id, status, current_attempt_id
     from agent_step_runs
     where id = $1 and job_id = $2`,
    [stepRunId, jobId]
  );
  const row = scope.rows[0];
  if (!row) {
    throw new AgentStoreError(
      'INVALID_JOB_STATE',
      `StepRun ${JSON.stringify(stepRunId)} does not belong to Job ${JSON.stringify(jobId)}.`
    );
  }
  await client.query(`select id from agent_plans where id = $1 for update`, [row.plan_id]);
  await client.query(`select id from agent_plan_steps where id = $1 for update`, [row.step_id]);
  const lockedRun = await client.query<{
    status: string;
    current_attempt_id: string | null;
  }>(
    `select status, current_attempt_id from agent_step_runs where id = $1 for update`,
    [stepRunId]
  );
  return {
    planId: row.plan_id,
    stepId: row.step_id,
    runStatus: requireRow(lockedRun.rows[0], 'lock step run').status,
    currentAttemptId: requireRow(lockedRun.rows[0], 'lock step run').current_attempt_id,
  };
}

async function selectUserInputRequest(
  client: PoolClient,
  requestId: string
): Promise<AgentUserInputRequestRow | undefined> {
  const result = await client.query<AgentUserInputRequestRow>(
    `select * from agent_user_input_requests where id = $1`,
    [requestId]
  );
  return result.rows[0];
}

async function selectMessageById(
  client: PoolClient,
  messageId: string
): Promise<AgentMessageRow | undefined> {
  const result = await client.query<AgentMessageRow>(
    `select * from agent_messages where id = $1`,
    [messageId]
  );
  return result.rows[0];
}

function userInputNotFound(requestId: string): AgentStoreError {
  return new AgentStoreError(
    'USER_INPUT_REQUEST_NOT_FOUND',
    `User input request ${JSON.stringify(requestId)} was not found.`,
    { requestId }
  );
}

async function touchSession(
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
