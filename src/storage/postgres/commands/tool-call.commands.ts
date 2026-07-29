import type { PoolClient } from 'pg';
import {
  AgentStoreError,
  type CompleteTaskWithFinalMessageInput,
  type CompleteTaskWithFinalMessageResult,
  type CompleteToolCallInput,
  type CompleteToolCallResult,
  type SaveToolCallsInput,
  type SaveToolCallsResult,
  type StartToolRunInput,
  type StartToolRunResult,
} from '../../agent-store.js';
import {
  mapAgentArtifactRow,
  mapAgentMessageRow,
  mapAgentTaskRow,
  mapAgentTaskRunRow,
  mapAgentToolCallRow,
  mapAgentToolRunRow,
  type AgentArtifactRow,
  type AgentMessageRow,
  type AgentTaskRow,
  type AgentTaskRunRow,
  type AgentToolCallRow,
  type AgentToolRunRow,
} from '../row-mappers.js';
import {
  lockAgentSession,
  lockAgentSessionForTask,
  withPostgresTransaction,
} from '../sql.js';
import {
  appendTaskCheckpoint,
  assertTaskRunOwnership,
  requireRow,
  selectActiveToolRun,
  selectLatestTaskCheckpoint,
  selectTask,
  selectTaskRun,
  selectToolCall,
  taskNotFound,
  toolCallNotFound,
  touchSession,
} from './command-helpers.js';
import {
  appendTerminalTaskCheckpoint,
  assertNoActiveTaskChildren,
} from './task-terminalization.helper.js';

export async function saveToolCallsCommand(
  client: PoolClient,
  input: SaveToolCallsInput
): Promise<SaveToolCallsResult> {
  if (input.toolCalls.length === 0) throw new TypeError('saveToolCalls requires at least one ToolCall.');
  const ids = input.toolCalls.map(item => item.call.id);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError('modelToolCallId values must be unique within one model output.');
  }
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const task = await selectTask(client, input.taskId, true);
    if (!task || task.session_id !== input.sessionId) throw taskNotFound(input.taskId);
    const taskRun = await selectTaskRun(client, input.taskRunId, true);
    assertTaskRunOwnership(task, taskRun, input.ownerId, input.nowMs);

    const existingMessageResult = await client.query<AgentMessageRow>(
      `select * from agent_messages where task_id = $1 and output_id = $2`,
      [input.taskId, input.outputId]
    );
    if (existingMessageResult.rows[0]) {
      const existingCalls = await client.query<AgentToolCallRow>(
        `select * from agent_tool_calls
         where call_message_id = $1
         order by created_at_ms, id`,
        [existingMessageResult.rows[0].id]
      );
      return {
        message: mapAgentMessageRow(existingMessageResult.rows[0]),
        toolCalls: existingCalls.rows.map(mapAgentToolCallRow),
      };
    }

    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, task_id, task_run_id, output_id,
         role, message_type, context_scope, visibility, channel,
         content, tool_calls, created_at_ms
       ) values (
         $1, $2, $3, $4, $5,
         'assistant', 'tool_call', $6, 'ui', 'normal',
         $7, $8, $9
       ) returning *`,
      [
        input.messageId,
        input.sessionId,
        input.taskId,
        input.taskRunId,
        input.outputId,
        input.contextScope,
        input.content,
        JSON.stringify(input.toolCalls.map(item => item.call)),
        input.nowMs,
      ]
    );
    const callRows: AgentToolCallRow[] = [];
    for (const toolCall of input.toolCalls) {
      const callResult = await client.query<AgentToolCallRow>(
        `insert into agent_tool_calls(
           id, session_id, task_id, created_in_task_run_id,
           call_message_id, model_tool_call_id, tool_name, arguments,
           arguments_checksum, side_effect_level, idempotency_key,
           status, version, metadata, created_at_ms, updated_at_ms
         ) values (
           $1, $2, $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11,
           'pending', 0, $12, $13, $13
         ) returning *`,
        [
          toolCall.id,
          input.sessionId,
          input.taskId,
          input.taskRunId,
          input.messageId,
          toolCall.call.id,
          toolCall.call.name,
          JSON.stringify(toolCall.call.args),
          toolCall.argumentsChecksum,
          toolCall.sideEffectLevel,
          toolCall.idempotencyKey,
          toolCall.metadata ?? null,
          input.nowMs,
        ]
      );
      callRows.push(requireRow(callResult.rows[0], 'save tool call'));
    }
    const previous = await selectLatestTaskCheckpoint(client, input.taskId);
    await appendTaskCheckpoint(client, {
      sessionId: input.sessionId,
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      phase: 'tool_batch',
      callMessageId: input.messageId,
      iterationNo: (previous?.iteration_no ?? -1) + 1,
      executedToolCalls: (previous?.executed_tool_calls ?? 0) + input.toolCalls.length,
      metadata: { modelToolCallIds: ids },
      nowMs: input.nowMs,
    });
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'save tool call message')),
      toolCalls: callRows.map(mapAgentToolCallRow),
    };
  });
}

export async function startToolRunCommand(
  client: PoolClient,
  input: StartToolRunInput
): Promise<StartToolRunResult> {
  return withPostgresTransaction(client, async () => {
    await lockAgentSessionForTask(client, input.taskId);
    const task = await selectTask(client, input.taskId, true);
    if (!task) throw taskNotFound(input.taskId);
    const taskRun = await selectTaskRun(client, input.taskRunId, true);
    assertTaskRunOwnership(task, taskRun, input.workerId, input.nowMs);
    const call = await selectToolCall(client, input.taskId, input.modelToolCallId, true);
    if (!call) throw toolCallNotFound(input.taskId, input.modelToolCallId);
    if (['completed', 'failed'].includes(call.status)) {
      const latestRun = await client.query<AgentToolRunRow>(
        `select * from agent_tool_runs
         where tool_call_id = $1 order by run_no desc limit 1`,
        [call.id]
      );
      return {
        toolCall: mapAgentToolCallRow(call),
        ...(latestRun.rows[0] ? { toolRun: mapAgentToolRunRow(latestRun.rows[0]) } : {}),
        started: false,
      };
    }
    if (call.status !== 'pending') {
      throw new AgentStoreError(
        'INVALID_TOOL_CALL_STATE',
        `ToolCall ${JSON.stringify(call.model_tool_call_id)} cannot start from ${call.status}.`,
        { taskId: task.id, modelToolCallId: call.model_tool_call_id, status: call.status }
      );
    }
    const runNoResult = await client.query<{ run_no: number }>(
      `select coalesce(max(run_no), 0)::integer + 1 as run_no
       from agent_tool_runs where tool_call_id = $1`,
      [call.id]
    );
    const runNo = requireRow(runNoResult.rows[0], 'select tool run number').run_no;
    const runResult = await client.query<AgentToolRunRow>(
      `insert into agent_tool_runs(
         id, tool_call_id, task_id, task_run_id, run_no, worker_id,
         status, started_at_ms
       ) values ($1, $2, $3, $4, $5, $6, 'running', $7)
       returning *`,
      [input.toolRunId, call.id, task.id, taskRun.id, runNo, input.workerId, input.nowMs]
    );
    const callResult = await client.query<AgentToolCallRow>(
      `update agent_tool_calls
       set status = 'running', version = version + 1,
           started_at_ms = coalesce(started_at_ms, $2), updated_at_ms = $2,
           error_code = null, error_message = null, error_details = null
       where id = $1 returning *`,
      [call.id, input.nowMs]
    );
    await touchSession(client, task.session_id, input.nowMs);
    return {
      toolCall: mapAgentToolCallRow(requireRow(callResult.rows[0], 'start tool call')),
      toolRun: mapAgentToolRunRow(requireRow(runResult.rows[0], 'start tool run')),
      started: true,
    };
  });
}

export async function completeToolCallCommand(
  client: PoolClient,
  input: CompleteToolCallInput
): Promise<CompleteToolCallResult> {
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const task = await selectTask(client, input.taskId, true);
    if (!task || task.session_id !== input.sessionId) throw taskNotFound(input.taskId);
    const taskRun = await selectTaskRun(client, input.taskRunId, true);
    const call = await selectToolCall(client, input.taskId, input.modelToolCallId, true);
    if (!call) throw toolCallNotFound(input.taskId, input.modelToolCallId);
    if (['completed', 'failed', 'outcome_unknown'].includes(call.status) && call.result_message_id) {
      const message = await client.query<AgentMessageRow>(
        `select * from agent_messages where id = $1`,
        [call.result_message_id]
      );
      const run = await client.query<AgentToolRunRow>(
        `select * from agent_tool_runs where tool_call_id = $1 order by run_no desc limit 1`,
        [call.id]
      );
      const artifacts = await client.query<AgentArtifactRow>(
        `select * from agent_artifacts where tool_call_id = $1 and result_message_id = $2`,
        [call.id, call.result_message_id]
      );
      return {
        message: mapAgentMessageRow(requireRow(message.rows[0], 'load tool result message')),
        toolCall: mapAgentToolCallRow(call),
        toolRun: mapAgentToolRunRow(requireRow(run.rows[0], 'load tool run')),
        artifacts: artifacts.rows.map(mapAgentArtifactRow),
        ...(call.status === 'outcome_unknown' && task.status === 'recovery_required'
          ? {
              recoveryRequired: {
                task: mapAgentTaskRow(task),
                taskRun: mapAgentTaskRunRow(requireRow(taskRun, 'load interrupted task run')),
              },
            }
          : {}),
      };
    }
    assertTaskRunOwnership(task, taskRun, input.ownerId, input.nowMs);
    if (call.status !== 'running') {
      throw new AgentStoreError(
        'INVALID_TOOL_CALL_STATE',
        `ToolCall ${JSON.stringify(call.model_tool_call_id)} cannot complete from ${call.status}.`,
        { taskId: task.id, modelToolCallId: call.model_tool_call_id, status: call.status }
      );
    }
    const activeRun = await selectActiveToolRun(client, call.id, true);
    if (!activeRun || activeRun.task_run_id !== taskRun.id) {
      throw new AgentStoreError(
        'INVALID_TOOL_CALL_STATE',
        `ToolCall ${JSON.stringify(call.model_tool_call_id)} has no running ToolRun in this TaskRun.`,
        { taskId: task.id, taskRunId: taskRun.id, modelToolCallId: call.model_tool_call_id }
      );
    }
    const callMessage = await client.query<Pick<AgentMessageRow, 'context_scope'>>(
      `select context_scope from agent_messages where id = $1`,
      [call.call_message_id]
    );
    const contextScope = requireRow(callMessage.rows[0], 'load tool call message').context_scope;
    const outcomeUnknown = input.outcome.status === 'failed'
      && input.outcome.executionStarted !== false
      && call.side_effect_level === 'side_effecting';
    const terminalStatus = outcomeUnknown ? 'outcome_unknown' : input.outcome.status;
    const errorCode = input.outcome.status === 'failed'
      ? outcomeUnknown ? 'side_effect_outcome_unknown' : input.outcome.code
      : null;
    const errorMessage = input.outcome.status === 'failed'
      ? outcomeUnknown
        ? `The side-effecting tool failed after execution started; its outcome is unknown. ${input.outcome.message}`
        : input.outcome.message
      : null;
    const errorDetails = input.outcome.status === 'failed'
      ? outcomeUnknown
        ? {
            executionStarted: true,
            originalError: {
              code: input.outcome.code,
              message: input.outcome.message,
              details: input.outcome.details,
            },
          }
        : input.outcome.details
      : undefined;
    const toolResult = input.outcome.status === 'completed'
      ? {
          status: 'completed' as const,
          result: input.outcome.result,
          durationMs: input.outcome.durationMs,
        }
      : {
          status: 'failed' as const,
          code: errorCode!,
          error: errorMessage!,
          details: errorDetails,
          durationMs: input.outcome.durationMs,
        };
    const content = input.outcome.status === 'completed'
      ? input.outcome.content
      : errorMessage!;
    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, task_id, task_run_id,
         role, message_type, context_scope, visibility, channel,
         content, model_tool_call_id, tool_name, tool_result, created_at_ms
       ) values (
         $1, $2, $3, $4,
         'tool', 'tool_result', $5, 'ui', 'normal',
         $6, $7, $8, $9, $10
       ) returning *`,
      [
        input.messageId,
        input.sessionId,
        input.taskId,
        input.taskRunId,
        contextScope,
        content,
        input.modelToolCallId,
        call.tool_name,
        JSON.stringify(toolResult),
        input.nowMs,
      ]
    );
    const runResult = await client.query<AgentToolRunRow>(
      `update agent_tool_runs
       set status = $2, error_code = $3, error_message = $4, error_details = $5,
           ended_at_ms = $6, duration_ms = $7
       where id = $1 returning *`,
      [
        activeRun.id,
        terminalStatus,
        errorCode,
        errorMessage,
        errorDetails !== undefined
          ? JSON.stringify(errorDetails)
          : null,
        input.nowMs,
        input.outcome.durationMs,
      ]
    );
    const callResult = await client.query<AgentToolCallRow>(
      `update agent_tool_calls
       set status = $2, result_message_id = $3,
           error_code = $4, error_message = $5, error_details = $6,
           version = version + 1,
           completed_at_ms = case
             when $2::text in ('completed', 'failed') then $7::bigint
             else null::bigint
           end,
           updated_at_ms = $7
       where id = $1 returning *`,
      [
        call.id,
        terminalStatus,
        input.messageId,
        errorCode,
        errorMessage,
        errorDetails !== undefined
          ? JSON.stringify(errorDetails)
          : null,
        input.nowMs,
      ]
    );
    const artifactRows: AgentArtifactRow[] = [];
    if (input.outcome.status === 'completed') {
      for (const artifact of input.outcome.artifacts ?? []) {
        const revisionResult = await client.query<{ revision: number }>(
          `select coalesce(max(revision), 0)::integer + 1 as revision
           from agent_artifacts where session_id = $1 and logical_path = $2`,
          [input.sessionId, artifact.logicalPath]
        );
        const revision = requireRow(revisionResult.rows[0], 'select artifact revision').revision;
        const result = await client.query<AgentArtifactRow>(
          `insert into agent_artifacts(
             id, session_id, task_id, tool_call_id, tool_run_id, result_message_id,
             kind, area, title, file_name, logical_path, storage_path,
             media_type, size_bytes, checksum, revision, metadata, created_at_ms
           ) values (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18
           ) returning *`,
          [
            artifact.id,
            input.sessionId,
            input.taskId,
            call.id,
            activeRun.id,
            input.messageId,
            artifact.kind,
            artifact.area,
            artifact.title,
            artifact.fileName,
            artifact.logicalPath,
            artifact.storagePath,
            artifact.mediaType,
            artifact.size,
            artifact.checksum,
            revision,
            artifact.metadata ?? null,
            input.nowMs,
          ]
        );
        artifactRows.push(requireRow(result.rows[0], 'save artifact'));
      }
    }
    let recoveryRequired: CompleteToolCallResult['recoveryRequired'];
    if (outcomeUnknown) {
      const interruptedRun = await client.query<AgentTaskRunRow>(
        `update agent_task_runs
         set status = 'interrupted', owner_id = null, ownership_expires_at_ms = null,
             error_code = $2, error_message = $3, error_details = $4,
             updated_at_ms = $5, ended_at_ms = $5
         where id = $1 returning *`,
        [taskRun.id, errorCode, errorMessage, JSON.stringify(errorDetails), input.nowMs]
      );
      const blockedTask = await client.query<AgentTaskRow>(
        `update agent_tasks
         set status = 'recovery_required', error_code = $2, error_message = $3, error_details = $4,
             version = version + 1, updated_at_ms = $5
         where id = $1 returning *`,
        [task.id, errorCode, errorMessage, JSON.stringify(errorDetails), input.nowMs]
      );
      recoveryRequired = {
        task: mapAgentTaskRow(requireRow(blockedTask.rows[0], 'require tool outcome recovery')),
        taskRun: mapAgentTaskRunRow(requireRow(interruptedRun.rows[0], 'interrupt unknown tool run')),
      };
    }
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'save tool result message')),
      toolCall: mapAgentToolCallRow(requireRow(callResult.rows[0], 'complete tool call')),
      toolRun: mapAgentToolRunRow(requireRow(runResult.rows[0], 'complete tool run')),
      artifacts: artifactRows.map(mapAgentArtifactRow),
      ...(recoveryRequired ? { recoveryRequired } : {}),
    };
  });
}

export async function completeTaskCommand(
  client: PoolClient,
  input: CompleteTaskWithFinalMessageInput
): Promise<CompleteTaskWithFinalMessageResult> {
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const task = await selectTask(client, input.taskId, true);
    if (!task || task.session_id !== input.sessionId) throw taskNotFound(input.taskId);
    const taskRun = await selectTaskRun(client, input.taskRunId, true);
    assertTaskRunOwnership(task, taskRun, input.ownerId, input.nowMs);
    await assertNoActiveTaskChildren(client, task.id);
    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, task_id, task_run_id, output_id,
         role, message_type, context_scope, visibility, channel, content, created_at_ms
       ) values (
         $1, $2, $3, $4, $5,
         'assistant', 'assistant_message', 'conversation', 'ui', 'final', $6, $7
       ) returning *`,
      [
        input.messageId,
        input.sessionId,
        input.taskId,
        input.taskRunId,
        input.outputId,
        input.content,
        input.nowMs,
      ]
    );
    const runResult = await client.query<AgentTaskRunRow>(
      `update agent_task_runs
       set status = 'completed', owner_id = null, ownership_expires_at_ms = null,
           updated_at_ms = $2, ended_at_ms = $2
       where id = $1 returning *`,
      [taskRun.id, input.nowMs]
    );
    const taskResult = await client.query<AgentTaskRow>(
      `update agent_tasks
       set status = 'completed', version = version + 1,
           updated_at_ms = $2, completed_at_ms = $2,
           error_code = null, error_message = null, error_details = null
       where id = $1 returning *`,
      [task.id, input.nowMs]
    );
    const checkpoint = await appendTerminalTaskCheckpoint(client, {
      sessionId: input.sessionId,
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      phase: 'completed',
      nowMs: input.nowMs,
    });
    const planResult = await client.query(
      `delete from agent_active_plans where session_id = $1 and task_id = $2`,
      [input.sessionId, input.taskId]
    );
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      task: mapAgentTaskRow(requireRow(taskResult.rows[0], 'complete task')),
      taskRun: mapAgentTaskRunRow(requireRow(runResult.rows[0], 'complete task run')),
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'save final message')),
      toolCalls: [],
      toolRuns: [],
      userInputRequests: [],
      ...(checkpoint ? { checkpoint } : {}),
      planCleared: planResult.rowCount === 1,
    };
  });
}
