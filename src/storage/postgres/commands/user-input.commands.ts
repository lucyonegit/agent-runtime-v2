import type { PoolClient } from 'pg';
import {
  AgentStoreError,
  type CreateInputRequestsAndMarkWaitingInput,
  type CreateInputRequestsAndMarkWaitingResult,
  type SaveUserInputAnswerInput,
  type SaveUserInputAnswerResult
} from '../../agent-store.js';
import {
  mapAgentJobRow,
  mapAgentMessageRow,
  mapAgentToolInvocationRow,
  mapAgentUserInputRequestRow,
  type AgentJobRow,
  type AgentMessageRow,
  type AgentToolInvocationRow,
  type AgentUserInputRequestRow
} from '../row-mappers.js';
import { lockAgentSession, withPostgresTransaction } from '../sql.js';
import {
  appendLoopCheckpoint,
  assertFutureLease,
  assertJobLease,
  jobNotFound,
  requireRow,
  resolveActivePlanScope,
  selectJob,
  selectLatestLoopCheckpoint,
  selectMessageById,
  selectUserInputRequest,
  touchSession,
  userInputNotFound
} from './command-helpers.js';

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
    const planScope = await resolveActivePlanScope(client, input.jobId);

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
           id, session_id, job_id, plan_id, plan_step_id, tool_invocation_id,
           source, answer_mode, status, title, prompt, input_schema,
           version, metadata, created_at_ms, updated_at_ms
         ) values (
           $1, $2, $3, $4, $5, $6,
           $7, $8, 'pending', $9, $10, $11,
           0, $12, $13, $13
         )
         returning *`,
        [
          request.requestId,
          input.sessionId,
          input.jobId,
          invocation?.plan_id ?? planScope?.planId ?? null,
          invocation?.plan_step_id ?? planScope?.planStepId ?? null,
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
    const previousCheckpoint = await selectLatestLoopCheckpoint(client, input.jobId);
    const callMessageId = invocationRows[0]?.call_message_id
      ?? previousCheckpoint?.call_message_id;
    if (!callMessageId) {
      throw new AgentStoreError(
        'INVALID_TOOL_INVOCATION_STATE',
        'Waiting for tool input requires a durable tool batch checkpoint.'
      );
    }
    await appendLoopCheckpoint(client, {
      sessionId: input.sessionId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      phase: 'waiting_user_input',
      callMessageId,
      iterationNo: previousCheckpoint?.iteration_no ?? 0,
      executedToolCalls: previousCheckpoint?.executed_tool_calls ?? 0,
      metadata: { requestIds: requestRows.map(row => row.id) },
      nowMs: input.nowMs,
    });
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      job: mapAgentJobRow(requireRow(waitingJob.rows[0], 'mark job waiting')),
      requests: requestRows.map(mapAgentUserInputRequestRow),
      invocations: updatedInvocationRows.map(mapAgentToolInvocationRow),
    };
  });
}

export async function saveUserInputAnswerAndResumeIfReadyCommand(
  client: PoolClient,
  input: SaveUserInputAnswerInput
): Promise<SaveUserInputAnswerResult> {
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
         id, session_id, job_id, plan_id, plan_step_id, attempt_id,
         role, message_type, visibility, channel, content,
         tool_call_id, tool_name, tool_result, created_at_ms
       ) values (
         $1, $2, $3, $4, $5, $6,
         $7, $8, 'ui', 'normal', $9,
         $10, $11, $12, $13
       )
       returning *`,
      [
        input.answerMessageId,
        request.session_id,
        request.job_id,
        request.plan_id,
        request.plan_step_id,
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
      job = requireRow(resumedJob.rows[0], 'resume job');
      const previousCheckpoint = await selectLatestLoopCheckpoint(client, job.id);
      const callMessageId = invocation?.call_message_id ?? previousCheckpoint?.call_message_id;
      const unfinished = callMessageId
        ? await client.query<{ count: string }>(
            `select count(*)::text as count
             from agent_tool_invocations
             where call_message_id = $1
               and status not in ('completed', 'failed')`,
            [callMessageId]
          )
        : undefined;
      const phase = unfinished?.rows[0]?.count === '0' || !callMessageId
        ? 'ready_for_model' as const
        : 'tool_batch' as const;
      await appendLoopCheckpoint(client, {
        sessionId: request.session_id,
        jobId: job.id,
        attemptId: input.attemptId,
        phase,
        ...(phase === 'tool_batch' && callMessageId ? { callMessageId } : {}),
        iterationNo: previousCheckpoint?.iteration_no ?? 0,
        executedToolCalls: previousCheckpoint?.executed_tool_calls ?? 0,
        metadata: { resumedFromUserInputRequestId: request.id },
        nowMs: input.nowMs,
      });
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
