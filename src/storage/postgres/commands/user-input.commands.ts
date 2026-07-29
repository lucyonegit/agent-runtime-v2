import type { PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import {
  isAgentSideEffectConfirmation,
  validateAgentUserInputAnswer,
  validateAgentUserInputSchema,
  type AgentSideEffectConfirmation,
  type AgentToolResult,
} from '../../../domain/index.js';
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
  mapAgentUserInputRequestRow,
  type AgentMessageRow,
  type AgentTaskRow,
  type AgentTaskRunRow,
  type AgentToolCallRow,
  type AgentUserInputRequestRow,
} from '../row-mappers.js';
import { lockAgentSession, withPostgresTransaction } from '../sql.js';
import {
  assertFutureOwnership,
  assertTaskRunOwnership,
  requireRow,
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
import {
  terminalizeTaskChildren,
} from './task-terminalization.helper.js';

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
  for (const request of input.requests) {
    const validation = validateAgentUserInputSchema(request.inputSchema);
    if (!validation.valid) throw new TypeError(validation.reason);
  }
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const task = await selectTask(client, input.taskId, true);
    if (!task || task.session_id !== input.sessionId) throw taskNotFound(input.taskId);
    const taskRun = await selectTaskRun(client, input.taskRunId, true);
    assertTaskRunOwnership(task, taskRun, input.ownerId, input.nowMs);

    const callRows: AgentToolCallRow[] = [];
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
      const callResult = await client.query<AgentToolCallRow>(
        `update agent_tool_calls
         set status = 'waiting_for_user', version = version + 1, updated_at_ms = $2
         where id = $1 returning *`,
        [call.id, input.nowMs]
      );
      callRows.push(requireRow(callResult.rows[0], 'mark tool call waiting'));
      const requestResult = await client.query<AgentUserInputRequestRow>(
        `insert into agent_user_input_requests(
           id, session_id, task_id, tool_call_id, kind, status,
           title, prompt, input_schema, expires_at_ms,
           version, metadata, created_at_ms, updated_at_ms
         ) values (
           $1, $2, $3, $4, $5, 'pending',
           $6, $7, $8, $9,
           0, $10, $11, $11
         ) returning *`,
        [
          request.requestId,
          input.sessionId,
          input.taskId,
          call.id,
          request.kind,
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
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      task: mapAgentTaskRow(requireRow(waitingTaskResult.rows[0], 'mark task waiting')),
      taskRun: mapAgentTaskRunRow(requireRow(pausedRunResult.rows[0], 'pause task run')),
      requests: requestRows.map(mapAgentUserInputRequestRow),
      toolCalls: callRows.map(mapAgentToolCallRow),
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
      const answerMessage = request.answer_message_id
        ? await selectMessageById(client, request.answer_message_id)
        : undefined;
      const mappedAnswerMessage = answerMessage ? mapAgentMessageRow(answerMessage) : undefined;
      if (request.client_answer_id !== input.clientAnswerId
        || !mappedAnswerMessage
        || !isDeepStrictEqual(committedUserAnswer(request.kind, mappedAnswerMessage.toolResult), input.answer)) {
        throw new AgentStoreError(
          'USER_INPUT_ANSWER_CONFLICT',
          `UserInputRequest ${JSON.stringify(request.id)} was already answered differently.`,
          { requestId: request.id }
        );
      }
      return {
        request: mapAgentUserInputRequestRow(request),
        answerMessage: mappedAnswerMessage,
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
    const expectedCallStatus = request.kind === 'side_effect_confirmation'
      ? 'outcome_unknown'
      : 'waiting_for_user';
    if (task.status !== 'waiting_for_user' || call.status !== expectedCallStatus) {
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
    const confirmation = request.kind === 'side_effect_confirmation'
      ? input.answer
      : undefined;
    if (request.kind === 'side_effect_confirmation'
      && !isAgentSideEffectConfirmation(confirmation)) {
      throw new AgentStoreError(
        'INVALID_USER_INPUT_ANSWER',
        'Side-effect confirmation requires one declared confirmation value.',
        { requestId: request.id }
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
    const answerOutcome = userInputAnswerOutcome(
      request.kind,
      input.answer,
      confirmation as AgentSideEffectConfirmation | undefined
    );
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
        answerOutcome.content,
        call.model_tool_call_id,
        call.tool_name,
        JSON.stringify(answerOutcome.toolResult),
        input.nowMs,
      ]
    );
    const callUpdate = await client.query<AgentToolCallRow>(
      `update agent_tool_calls
       set status = $2, result_message_id = $3,
           error_code = $4, error_message = $5, error_details = $6,
           version = version + 1, completed_at_ms = $7, updated_at_ms = $7
       where id = $1 returning *`,
      [
        call.id,
        answerOutcome.callStatus,
        input.answerMessageId,
        answerOutcome.errorCode,
        answerOutcome.errorMessage,
        answerOutcome.errorDetails === undefined
          ? null
          : JSON.stringify(answerOutcome.errorDetails),
        input.nowMs,
      ]
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
    const stopTask = confirmation === 'cannot_confirm_and_stop';
    const shouldResume = !stopTask
      && requireRow(remainingResult.rows[0], 'count pending input requests').count === 0;
    let resumedTask = task;
    let newTaskRun: AgentTaskRunRow | undefined;
    let taskFinish: SaveUserInputAnswerResult['taskFinish'];
    if (stopTask) {
      const children = await terminalizeTaskChildren(client, {
        taskId: task.id,
        phase: 'failed',
        nowMs: input.nowMs,
      });
      const runResult = await client.query<AgentTaskRunRow>(
        `update agent_task_runs
         set status = 'failed',
             error_code = 'side_effect_outcome_unconfirmed',
             error_message = 'The user could not confirm whether the side effect occurred.',
             error_details = null, updated_at_ms = $2, ended_at_ms = $2
         where id = $1 and status = 'paused'
         returning *`,
        [call.created_in_task_run_id, input.nowMs]
      );
      const taskResult = await client.query<AgentTaskRow>(
        `update agent_tasks
         set status = 'failed',
             error_code = 'side_effect_outcome_unconfirmed',
             error_message = 'The user could not confirm whether the side effect occurred.',
             error_details = null, version = version + 1,
             updated_at_ms = $2, completed_at_ms = $2
         where id = $1 returning *`,
        [task.id, input.nowMs]
      );
      resumedTask = requireRow(taskResult.rows[0], 'stop task after unknown side effect');
      await client.query(
        `update agent_messages set task_run_id = $2 where id = $1`,
        [input.answerMessageId, call.created_in_task_run_id]
      );
      const planResult = await client.query(
        `delete from agent_active_plans where session_id = $1 and task_id = $2`,
        [task.session_id, task.id]
      );
      const answeredRequest = mapAgentUserInputRequestRow(
        requireRow(requestUpdate.rows[0], 'answer side-effect confirmation')
      );
      const answeredCall = mapAgentToolCallRow(
        requireRow(callUpdate.rows[0], 'close unknown side effect')
      );
      taskFinish = {
        task: mapAgentTaskRow(resumedTask),
        ...(runResult.rows[0] ? { taskRun: mapAgentTaskRunRow(runResult.rows[0]) } : {}),
        toolCalls: [answeredCall, ...children.toolCalls],
        userInputRequests: [answeredRequest, ...children.userInputRequests],
        planCleared: planResult.rowCount === 1,
      };
    } else if (shouldResume) {
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
         set status = 'running',
             error_code = null, error_message = null, error_details = null,
             version = version + 1, updated_at_ms = $2
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
    }
    await touchSession(client, task.session_id, input.nowMs);
    const returnedMessage = shouldResume || stopTask
      ? await selectMessageById(client, input.answerMessageId)
      : messageResult.rows[0];
    return {
      request: mapAgentUserInputRequestRow(requireRow(requestUpdate.rows[0], 'answer request')),
      answerMessage: mapAgentMessageRow(requireRow(returnedMessage, 'save answer message')),
      task: mapAgentTaskRow(resumedTask),
      ...(newTaskRun ? { taskRun: mapAgentTaskRunRow(newTaskRun) } : {}),
      toolCall: mapAgentToolCallRow(requireRow(callUpdate.rows[0], 'complete input tool call')),
      shouldResume,
      ...(taskFinish ? { taskFinish } : {}),
    };
  });
}

export async function expireUserInputCommand(
  client: PoolClient,
  input: ExpireUserInputRequestInput
): Promise<ExpireUserInputRequestResult> {
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
    const expectedCallStatus = request.kind === 'side_effect_confirmation'
      ? 'outcome_unknown'
      : 'waiting_for_user';
    if (
      request.status !== 'pending'
      || request.version !== input.expectedVersion
      || request.expires_at_ms === null
      || Number(request.expires_at_ms) > input.nowMs
      || task.status !== 'waiting_for_user'
      || call.status !== expectedCallStatus
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

    const sideEffectUnconfirmed = request.kind === 'side_effect_confirmation';
    const failureCode = sideEffectUnconfirmed
      ? 'side_effect_outcome_unconfirmed'
      : 'user_input_expired';
    const failureMessage = sideEffectUnconfirmed
      ? 'The side-effect confirmation expired; the operation outcome remains unknown and the task stopped.'
      : 'User input request expired before an answer was provided.';
    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, task_id, task_run_id, role, message_type, context_scope,
         visibility, channel, content, model_tool_call_id, tool_name,
         tool_result, created_at_ms
       ) values (
         $1, $2, $3, $4, 'tool', 'tool_result', $5,
         'ui', 'normal', $6, $7, $8, $9, $10
       ) returning *`,
      [
        input.resultMessageId,
        request.session_id,
        task.id,
        call.created_in_task_run_id,
        await toolCallContextScope(client, call.call_message_id),
        failureMessage,
        call.model_tool_call_id,
        call.tool_name,
        JSON.stringify({
          status: 'failed',
          code: failureCode,
          error: failureMessage,
          ...(sideEffectUnconfirmed ? {
            result: {
              confirmation: 'expired',
              originalToolResultUnavailable: true,
            },
          } : {}),
          durationMs: 0,
        }),
        input.nowMs,
      ]
    );
    const callUpdate = await client.query<AgentToolCallRow>(
      `update agent_tool_calls
       set status = 'failed', result_message_id = $2,
           error_code = $3, error_message = $4, error_details = null,
           version = version + 1, completed_at_ms = $5, updated_at_ms = $5
       where id = $1 returning *`,
      [call.id, input.resultMessageId, failureCode, failureMessage, input.nowMs]
    );
    const requestUpdate = await client.query<AgentUserInputRequestRow>(
      `update agent_user_input_requests
       set status = 'expired', version = version + 1, updated_at_ms = $2
       where id = $1 returning *`,
      [request.id, input.nowMs]
    );
    const children = await terminalizeTaskChildren(client, {
      taskId: task.id,
      phase: 'failed',
      nowMs: input.nowMs,
    });
    const runResult = await client.query<AgentTaskRunRow>(
      `update agent_task_runs
       set status = 'failed',
           error_code = $2, error_message = $3, error_details = null,
           updated_at_ms = $4, ended_at_ms = $4
       where id = $1 and status = 'paused'
       returning *`,
      [call.created_in_task_run_id, failureCode, failureMessage, input.nowMs]
    );
    const taskResult = await client.query<AgentTaskRow>(
      `update agent_tasks
       set status = 'failed',
           error_code = $2, error_message = $3, error_details = null,
           version = version + 1, updated_at_ms = $4, completed_at_ms = $4
       where id = $1 returning *`,
      [task.id, failureCode, failureMessage, input.nowMs]
    );
    const planResult = await client.query(
      `delete from agent_active_plans where session_id = $1 and task_id = $2`,
      [task.session_id, task.id]
    );
    await touchSession(client, task.session_id, input.nowMs);
    const expiredRequest = mapAgentUserInputRequestRow(
      requireRow(requestUpdate.rows[0], 'expire request')
    );
    const failedCall = mapAgentToolCallRow(
      requireRow(callUpdate.rows[0], 'fail expired input tool call')
    );
    return {
      request: expiredRequest,
      resultMessage: mapAgentMessageRow(
        requireRow(messageResult.rows[0], 'save expiration message')
      ),
      task: mapAgentTaskRow(requireRow(taskResult.rows[0], 'fail task after input expiration')),
      ...(runResult.rows[0] ? { taskRun: mapAgentTaskRunRow(runResult.rows[0]) } : {}),
      toolCall: failedCall,
      toolCalls: [failedCall, ...children.toolCalls],
      userInputRequests: [expiredRequest, ...children.userInputRequests],
      planCleared: planResult.rowCount === 1,
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

function committedUserAnswer(
  kind: string,
  result: AgentToolResult | undefined
): unknown {
  if (kind !== 'side_effect_confirmation') return result?.result;
  if (!result?.result || typeof result.result !== 'object') return undefined;
  return (result.result as { confirmation?: unknown }).confirmation;
}

function userInputAnswerOutcome(
  kind: string,
  answer: unknown,
  confirmation: AgentSideEffectConfirmation | undefined
): {
  content: string;
  toolResult: AgentToolResult;
  callStatus: 'completed' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails?: unknown;
} {
  if (kind !== 'side_effect_confirmation') {
    return {
      content: typeof answer === 'string' ? answer : JSON.stringify(answer),
      toolResult: { status: 'completed', result: answer, durationMs: 0 },
      callStatus: 'completed',
      errorCode: null,
      errorMessage: null,
    };
  }
  if (!confirmation) throw new TypeError('Side-effect confirmation is required.');
  const result = { confirmation, originalToolResultUnavailable: true };
  if (confirmation === 'confirmed_succeeded') {
    return {
      content: [
        'The user confirmed that the operation succeeded.',
        'The original tool result is unavailable; inspect current state if later work depends on it.',
      ].join(' '),
      toolResult: { status: 'completed', result, durationMs: 0 },
      callStatus: 'completed',
      errorCode: null,
      errorMessage: null,
    };
  }
  const stopped = confirmation === 'cannot_confirm_and_stop';
  const errorCode = stopped
    ? 'side_effect_outcome_unconfirmed'
    : 'side_effect_confirmed_not_applied';
  const errorMessage = stopped
    ? 'The user could not confirm whether the side effect occurred and stopped the task.'
    : 'The user confirmed that the side effect was not applied.';
  return {
    content: errorMessage,
    toolResult: {
      status: 'failed',
      result,
      code: errorCode,
      error: errorMessage,
      details: { originalToolResultUnavailable: true },
      durationMs: 0,
    },
    callStatus: 'failed',
    errorCode,
    errorMessage,
    errorDetails: { confirmation, originalToolResultUnavailable: true },
  };
}
