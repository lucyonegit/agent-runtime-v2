import type { PoolClient } from 'pg';
import { validateAgentUserInputAnswer } from '../../../domain/index.js';
import {
  AgentStoreError,
  type ExpireUserInputRequestInput,
  type ExpireUserInputRequestResult,
  type SaveUserInputAnswerInput,
  type SaveUserInputAnswerResult,
  type WaitForUserInputInput,
  type WaitForUserInputResult,
} from '../../agent-store.js';
import {
  mapAgentMessageRow,
  mapAgentTaskRow,
  mapAgentTaskRunRow,
  mapAgentToolCallRow,
  mapAgentToolRunRow,
  mapAgentUserInputRequestRow,
  type AgentMessageRow,
  type AgentTaskRow,
  type AgentTaskRunRow,
  type AgentToolCallRow,
  type AgentToolRunRow,
  type AgentUserInputRequestRow,
} from '../row-mappers.js';
import { lockAgentSession, withPostgresTransaction } from '../sql.js';
import {
  appendTaskCheckpoint,
  assertFutureOwnership,
  assertTaskRunOwnership,
  requireRow,
  selectActiveToolRun,
  selectLatestTaskCheckpoint,
  selectMessageById,
  selectTask,
  selectTaskRun,
  selectToolCall,
  selectUserInputRequest,
  taskNotFound,
  toolCallNotFound,
  touchSession,
  userInputNotFound,
} from './command-helpers.js';

export async function waitForUserInputCommand(
  client: PoolClient,
  input: WaitForUserInputInput
): Promise<WaitForUserInputResult> {
  if (input.requests.length === 0) throw new TypeError('At least one UserInputRequest is required.');
  if (new Set(input.requests.map(request => request.requestId)).size !== input.requests.length) {
    throw new TypeError('UserInputRequest IDs must be unique.');
  }
  if (new Set(input.requests.map(request => request.modelToolCallId)).size !== input.requests.length) {
    throw new TypeError('Only one UserInputRequest may be created for each ToolCall.');
  }
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const task = await selectTask(client, input.taskId, true);
    if (!task || task.session_id !== input.sessionId) throw taskNotFound(input.taskId);
    const taskRun = await selectTaskRun(client, input.taskRunId, true);
    assertTaskRunOwnership(task, taskRun, input.ownerId, input.nowMs);

    const callRows: AgentToolCallRow[] = [];
    const runRows: AgentToolRunRow[] = [];
    const requestRows: AgentUserInputRequestRow[] = [];
    for (const request of input.requests) {
      const call = await selectToolCall(client, input.taskId, request.modelToolCallId, true);
      if (!call) throw toolCallNotFound(input.taskId, request.modelToolCallId);
      if (call.status !== 'running') {
        throw new AgentStoreError(
          'INVALID_TOOL_CALL_STATE',
          `ToolCall ${JSON.stringify(call.model_tool_call_id)} cannot wait for input from ${call.status}.`,
          { taskId: task.id, modelToolCallId: call.model_tool_call_id, status: call.status }
        );
      }
      const activeRun = await selectActiveToolRun(client, call.id, true);
      if (!activeRun || activeRun.task_run_id !== taskRun.id) {
        throw new AgentStoreError(
          'INVALID_TOOL_CALL_STATE',
          `ToolCall ${JSON.stringify(call.model_tool_call_id)} has no running ToolRun.`,
          { taskId: task.id, taskRunId: taskRun.id, modelToolCallId: call.model_tool_call_id }
        );
      }
      const runResult = await client.query<AgentToolRunRow>(
        `update agent_tool_runs
         set status = 'completed', ended_at_ms = $2,
             duration_ms = greatest(0, $2 - started_at_ms)
         where id = $1 returning *`,
        [activeRun.id, input.nowMs]
      );
      runRows.push(requireRow(runResult.rows[0], 'complete input-request tool run'));
      const callResult = await client.query<AgentToolCallRow>(
        `update agent_tool_calls
         set status = 'waiting_for_user', version = version + 1, updated_at_ms = $2
         where id = $1 returning *`,
        [call.id, input.nowMs]
      );
      callRows.push(requireRow(callResult.rows[0], 'mark tool call waiting'));
      const requestResult = await client.query<AgentUserInputRequestRow>(
        `insert into agent_user_input_requests(
           id, session_id, task_id, tool_call_id, status,
           title, prompt, input_schema, expires_at_ms,
           version, metadata, created_at_ms, updated_at_ms
         ) values (
           $1, $2, $3, $4, 'pending',
           $5, $6, $7, $8,
           0, $9, $10, $10
         ) returning *`,
        [
          request.requestId,
          input.sessionId,
          input.taskId,
          call.id,
          request.title ?? null,
          request.prompt,
          JSON.stringify(request.inputSchema),
          request.expiresAtMs ?? null,
          request.metadata ?? null,
          input.nowMs,
        ]
      );
      requestRows.push(requireRow(requestResult.rows[0], 'create user input request'));
    }

    const pausedRunResult = await client.query<AgentTaskRunRow>(
      `update agent_task_runs
       set status = 'paused', owner_id = null, ownership_expires_at_ms = null,
           updated_at_ms = $2, ended_at_ms = $2
       where id = $1 returning *`,
      [taskRun.id, input.nowMs]
    );
    const waitingTaskResult = await client.query<AgentTaskRow>(
      `update agent_tasks
       set status = 'waiting_for_user', version = version + 1, updated_at_ms = $2
       where id = $1 returning *`,
      [task.id, input.nowMs]
    );
    const callMessageIds = [...new Set(callRows.map(call => call.call_message_id))];
    if (callMessageIds.length !== 1) {
      throw new AgentStoreError(
        'TOOL_CALL_CONFLICT',
        'One wait transition must come from a single model-produced tool batch.',
        { taskId: task.id, callMessageIds }
      );
    }
    const previous = await selectLatestTaskCheckpoint(client, task.id);
    await appendTaskCheckpoint(client, {
      sessionId: input.sessionId,
      taskId: task.id,
      taskRunId: taskRun.id,
      phase: 'waiting_for_user',
      callMessageId: callMessageIds[0],
      iterationNo: previous?.iteration_no ?? 0,
      executedToolCalls: previous?.executed_tool_calls ?? 0,
      metadata: { requestIds: requestRows.map(row => row.id) },
      nowMs: input.nowMs,
    });
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      task: mapAgentTaskRow(requireRow(waitingTaskResult.rows[0], 'mark task waiting')),
      taskRun: mapAgentTaskRunRow(requireRow(pausedRunResult.rows[0], 'pause task run')),
      requests: requestRows.map(mapAgentUserInputRequestRow),
      toolCalls: callRows.map(mapAgentToolCallRow),
      toolRuns: runRows.map(mapAgentToolRunRow),
    };
  });
}

export async function answerUserInputCommand(
  client: PoolClient,
  input: SaveUserInputAnswerInput
): Promise<SaveUserInputAnswerResult> {
  assertFutureOwnership(input.nowMs, input.ownershipExpiresAtMs);
  if (!input.clientAnswerId.trim()) throw new TypeError('clientAnswerId must not be empty.');
  if (input.answer === undefined) throw new TypeError('answer must be defined.');
  const initial = await selectUserInputRequest(client, input.requestId);
  if (!initial) throw userInputNotFound(input.requestId);
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, initial.session_id);
    const request = await selectUserInputRequest(client, input.requestId, true);
    if (!request) throw userInputNotFound(input.requestId);
    const task = await selectTask(client, request.task_id, true);
    if (!task) throw taskNotFound(request.task_id);
    const callResult = await client.query<AgentToolCallRow>(
      `select * from agent_tool_calls where id = $1 for update`,
      [request.tool_call_id]
    );
    const call = requireRow(callResult.rows[0], 'lock waiting tool call');

    if (request.status === 'answered') {
      if (request.client_answer_id !== input.clientAnswerId || !request.answer_message_id) {
        throw new AgentStoreError(
          'USER_INPUT_ANSWER_CONFLICT',
          `UserInputRequest ${JSON.stringify(request.id)} was already answered differently.`,
          { requestId: request.id }
        );
      }
      const answerMessage = await selectMessageById(client, request.answer_message_id);
      return {
        request: mapAgentUserInputRequestRow(request),
        answerMessage: mapAgentMessageRow(requireRow(answerMessage, 'load answer message')),
        task: mapAgentTaskRow(task),
        toolCall: mapAgentToolCallRow(call),
        shouldResume: false,
      };
    }
    if (request.status !== 'pending') {
      throw new AgentStoreError(
        'INVALID_USER_INPUT_STATE',
        `UserInputRequest ${JSON.stringify(request.id)} is ${request.status}.`,
        { requestId: request.id, status: request.status }
      );
    }
    if (request.version !== input.expectedVersion) {
      throw new AgentStoreError(
        'CONCURRENCY_CONFLICT',
        `UserInputRequest ${JSON.stringify(request.id)} version is stale.`,
        { requestId: request.id, expectedVersion: input.expectedVersion, actualVersion: request.version }
      );
    }
    if (task.status !== 'waiting_for_user' || call.status !== 'waiting_for_user') {
      throw new AgentStoreError(
        'INVALID_USER_INPUT_STATE',
        'The Task or ToolCall is no longer waiting for this answer.',
        { taskId: task.id, taskStatus: task.status, toolCallStatus: call.status }
      );
    }
    const mappedRequest = mapAgentUserInputRequestRow(request);
    const answerValidation = validateAgentUserInputAnswer(mappedRequest.inputSchema, input.answer);
    if (!answerValidation.valid) {
      throw new AgentStoreError(
        'INVALID_USER_INPUT_ANSWER',
        answerValidation.reason,
        { requestId: request.id, inputType: mappedRequest.inputSchema.type }
      );
    }
    const duplicateAnswer = await client.query<{ id: string }>(
      `select id from agent_user_input_requests
       where task_id = $1 and client_answer_id = $2 and id <> $3`,
      [task.id, input.clientAnswerId, request.id]
    );
    if (duplicateAnswer.rows[0]) {
      throw new AgentStoreError(
        'USER_INPUT_ANSWER_CONFLICT',
        `clientAnswerId ${JSON.stringify(input.clientAnswerId)} already belongs to another request.`,
        { requestId: request.id, conflictingRequestId: duplicateAnswer.rows[0].id }
      );
    }
    const content = typeof input.answer === 'string' ? input.answer : JSON.stringify(input.answer);
    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, task_id, role, message_type, context_scope,
         visibility, channel, content, model_tool_call_id, tool_name,
         tool_result, created_at_ms
       ) values (
         $1, $2, $3, 'tool', 'tool_result', $4,
         'ui', 'normal', $5, $6, $7,
         $8, $9
       ) returning *`,
      [
        input.answerMessageId,
        request.session_id,
        task.id,
        await toolCallContextScope(client, call.call_message_id),
        content,
        call.model_tool_call_id,
        call.tool_name,
        JSON.stringify({ status: 'completed', result: input.answer, durationMs: 0 }),
        input.nowMs,
      ]
    );
    const callUpdate = await client.query<AgentToolCallRow>(
      `update agent_tool_calls
       set status = 'completed', result_message_id = $2,
           error_code = null, error_message = null, error_details = null,
           version = version + 1, completed_at_ms = $3, updated_at_ms = $3
       where id = $1 returning *`,
      [call.id, input.answerMessageId, input.nowMs]
    );
    const requestUpdate = await client.query<AgentUserInputRequestRow>(
      `update agent_user_input_requests
       set status = 'answered', answer_message_id = $2, client_answer_id = $3,
           version = version + 1, updated_at_ms = $4, answered_at_ms = $4
       where id = $1 returning *`,
      [request.id, input.answerMessageId, input.clientAnswerId, input.nowMs]
    );
    const remainingResult = await client.query<{ count: number }>(
      `select count(*)::integer as count
       from agent_user_input_requests
       where task_id = $1 and status = 'pending'`,
      [task.id]
    );
    const shouldResume = requireRow(remainingResult.rows[0], 'count pending input requests').count === 0;
    let resumedTask = task;
    let newTaskRun: AgentTaskRunRow | undefined;
    if (shouldResume) {
      const runNoResult = await client.query<{ run_no: number }>(
        `select coalesce(max(run_no), 0)::integer + 1 as run_no
         from agent_task_runs where task_id = $1`,
        [task.id]
      );
      const runNo = requireRow(runNoResult.rows[0], 'select resumed task run number').run_no;
      const runResult = await client.query<AgentTaskRunRow>(
        `insert into agent_task_runs(
           id, task_id, run_no, trigger, status, owner_id, ownership_expires_at_ms,
           started_at_ms, updated_at_ms
         ) values ($1, $2, $3, 'user_input_answered', 'running', $4, $5, $6, $6)
         returning *`,
        [
          input.taskRunId,
          task.id,
          runNo,
          input.ownerId,
          input.ownershipExpiresAtMs,
          input.nowMs,
        ]
      );
      newTaskRun = requireRow(runResult.rows[0], 'create resumed task run');
      const taskResult = await client.query<AgentTaskRow>(
        `update agent_tasks
         set status = 'running', version = version + 1, updated_at_ms = $2
         where id = $1 returning *`,
        [task.id, input.nowMs]
      );
      resumedTask = requireRow(taskResult.rows[0], 'resume task after input');
      await client.query(
        `update agent_messages message
         set task_run_id = $2
         from agent_user_input_requests request
         where request.task_id = $1
           and request.answer_message_id = message.id
           and message.task_run_id is null`,
        [task.id, newTaskRun.id]
      );
      const previous = await selectLatestTaskCheckpoint(client, task.id);
      await appendTaskCheckpoint(client, {
        sessionId: task.session_id,
        taskId: task.id,
        taskRunId: newTaskRun.id,
        phase: 'ready_for_model',
        iterationNo: (previous?.iteration_no ?? -1) + 1,
        executedToolCalls: previous?.executed_tool_calls ?? 0,
        metadata: { resumedAfterUserInput: true },
        nowMs: input.nowMs,
      });
    }
    await touchSession(client, task.session_id, input.nowMs);
    const returnedMessage = shouldResume
      ? await selectMessageById(client, input.answerMessageId)
      : messageResult.rows[0];
    return {
      request: mapAgentUserInputRequestRow(requireRow(requestUpdate.rows[0], 'answer request')),
      answerMessage: mapAgentMessageRow(requireRow(returnedMessage, 'save answer message')),
      task: mapAgentTaskRow(resumedTask),
      ...(newTaskRun ? { taskRun: mapAgentTaskRunRow(newTaskRun) } : {}),
      toolCall: mapAgentToolCallRow(requireRow(callUpdate.rows[0], 'complete input tool call')),
      shouldResume,
    };
  });
}

export async function expireUserInputCommand(
  client: PoolClient,
  input: ExpireUserInputRequestInput
): Promise<ExpireUserInputRequestResult> {
  assertFutureOwnership(input.nowMs, input.ownershipExpiresAtMs);
  const initial = await selectUserInputRequest(client, input.requestId);
  if (!initial) throw userInputNotFound(input.requestId);
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, initial.session_id);
    const request = await selectUserInputRequest(client, input.requestId, true);
    if (!request) throw userInputNotFound(input.requestId);
    const task = await selectTask(client, request.task_id, true);
    if (!task) throw taskNotFound(request.task_id);
    const callResult = await client.query<AgentToolCallRow>(
      `select * from agent_tool_calls where id = $1 for update`,
      [request.tool_call_id]
    );
    const call = requireRow(callResult.rows[0], 'lock expired input tool call');
    if (
      request.status !== 'pending'
      || request.version !== input.expectedVersion
      || request.expires_at_ms === null
      || Number(request.expires_at_ms) > input.nowMs
      || task.status !== 'waiting_for_user'
      || call.status !== 'waiting_for_user'
    ) {
      throw new AgentStoreError(
        'INVALID_USER_INPUT_STATE',
        `UserInputRequest ${JSON.stringify(request.id)} is no longer eligible for expiration.`,
        {
          requestId: request.id,
          status: request.status,
          taskStatus: task.status,
          toolCallStatus: call.status,
        }
      );
    }

    const failureMessage = 'User input request expired before an answer was provided.';
    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, task_id, role, message_type, context_scope,
         visibility, channel, content, model_tool_call_id, tool_name,
         tool_result, created_at_ms
       ) values (
         $1, $2, $3, 'tool', 'tool_result', $4,
         'ui', 'normal', $5, $6, $7, $8, $9
       ) returning *`,
      [
        input.resultMessageId,
        request.session_id,
        task.id,
        await toolCallContextScope(client, call.call_message_id),
        failureMessage,
        call.model_tool_call_id,
        call.tool_name,
        JSON.stringify({
          status: 'failed',
          code: 'user_input_expired',
          message: failureMessage,
          durationMs: 0,
        }),
        input.nowMs,
      ]
    );
    const callUpdate = await client.query<AgentToolCallRow>(
      `update agent_tool_calls
       set status = 'failed', result_message_id = $2,
           error_code = 'user_input_expired', error_message = $3, error_details = null,
           version = version + 1, completed_at_ms = $4, updated_at_ms = $4
       where id = $1 returning *`,
      [call.id, input.resultMessageId, failureMessage, input.nowMs]
    );
    const requestUpdate = await client.query<AgentUserInputRequestRow>(
      `update agent_user_input_requests
       set status = 'expired', version = version + 1, updated_at_ms = $2
       where id = $1 returning *`,
      [request.id, input.nowMs]
    );
    const remainingResult = await client.query<{ count: number }>(
      `select count(*)::integer as count
       from agent_user_input_requests
       where task_id = $1 and status = 'pending'`,
      [task.id]
    );
    const shouldResume = requireRow(
      remainingResult.rows[0],
      'count pending input requests after expiration'
    ).count === 0;
    let resumedTask = task;
    let newTaskRun: AgentTaskRunRow | undefined;
    if (shouldResume) {
      const runNoResult = await client.query<{ run_no: number }>(
        `select coalesce(max(run_no), 0)::integer + 1 as run_no
         from agent_task_runs where task_id = $1`,
        [task.id]
      );
      const runNo = requireRow(runNoResult.rows[0], 'select expiration task run number').run_no;
      const runResult = await client.query<AgentTaskRunRow>(
        `insert into agent_task_runs(
           id, task_id, run_no, trigger, status, owner_id, ownership_expires_at_ms,
           started_at_ms, updated_at_ms
         ) values ($1, $2, $3, 'input_expired', 'running', $4, $5, $6, $6)
         returning *`,
        [
          input.taskRunId,
          task.id,
          runNo,
          input.ownerId,
          input.ownershipExpiresAtMs,
          input.nowMs,
        ]
      );
      newTaskRun = requireRow(runResult.rows[0], 'create expiration task run');
      const taskResult = await client.query<AgentTaskRow>(
        `update agent_tasks
         set status = 'running', version = version + 1, updated_at_ms = $2
         where id = $1 returning *`,
        [task.id, input.nowMs]
      );
      resumedTask = requireRow(taskResult.rows[0], 'resume task after input expiration');
      await client.query(
        `update agent_messages message
         set task_run_id = $2
         from agent_tool_calls tool_call
         where tool_call.task_id = $1
           and tool_call.result_message_id = message.id
           and message.task_run_id is null`,
        [task.id, newTaskRun.id]
      );
      const previous = await selectLatestTaskCheckpoint(client, task.id);
      await appendTaskCheckpoint(client, {
        sessionId: task.session_id,
        taskId: task.id,
        taskRunId: newTaskRun.id,
        phase: 'ready_for_model',
        iterationNo: (previous?.iteration_no ?? -1) + 1,
        executedToolCalls: previous?.executed_tool_calls ?? 0,
        metadata: { resumedAfterInputExpiration: true },
        nowMs: input.nowMs,
      });
    }
    await touchSession(client, task.session_id, input.nowMs);
    const returnedMessage = shouldResume
      ? await selectMessageById(client, input.resultMessageId)
      : messageResult.rows[0];
    return {
      request: mapAgentUserInputRequestRow(requireRow(requestUpdate.rows[0], 'expire request')),
      resultMessage: mapAgentMessageRow(requireRow(returnedMessage, 'save expiration message')),
      task: mapAgentTaskRow(resumedTask),
      ...(newTaskRun ? { taskRun: mapAgentTaskRunRow(newTaskRun) } : {}),
      toolCall: mapAgentToolCallRow(
        requireRow(callUpdate.rows[0], 'fail expired input tool call')
      ),
      shouldResume,
    };
  });
}

async function toolCallContextScope(client: PoolClient, messageId: string): Promise<string> {
  const result = await client.query<{ context_scope: string }>(
    `select context_scope from agent_messages where id = $1`,
    [messageId]
  );
  return requireRow(result.rows[0], 'load tool call context scope').context_scope;
}
