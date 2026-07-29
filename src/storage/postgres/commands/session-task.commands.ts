import type { PoolClient } from 'pg';
import type { AgentSession } from '../../../domain/index.js';
import {
  AgentStoreError,
  type BeginSessionDeletionInput,
  type BeginSessionDeletionResult,
  type CancelTaskInput,
  type CreateSessionInput,
  type CreateTaskWithUserMessageInput,
  type CreateTaskWithUserMessageResult,
  type FailTaskInput,
  type FinishTaskResult,
  type ReconcileInterruptedTaskInput,
  type ReconcileInterruptedTaskResult,
  type RenewTaskRunOwnershipInput,
  type StartTaskRunInput,
  type StartTaskRunResult,
} from '../../agent-store.js';
import {
  mapAgentMessageRow,
  mapAgentSessionRow,
  mapAgentTaskRow,
  mapAgentTaskRunRow,
  mapAgentToolCallRow,
  mapAgentUserInputRequestRow,
  type AgentMessageRow,
  type AgentSessionRow,
  type AgentTaskRow,
  type AgentTaskRunRow,
  type AgentToolCallRow,
  type AgentUserInputRequestRow,
} from '../row-mappers.js';
import { lockAgentSession, lockAgentSessionForTask, withPostgresTransaction } from '../sql.js';
import {
  assertFutureOwnership,
  assertTaskRunOwnership,
  isConstraint,
  requireRow,
  selectTask,
  selectTaskRun,
  taskNotFound,
  touchSession,
} from './command-helpers.js';
import {
  cancelLockedTask,
  terminalizeTaskChildren,
} from './task-terminalization.helper.js';

export async function createSessionCommand(
  client: PoolClient,
  input: CreateSessionInput
): Promise<AgentSession> {
  try {
    const result = await client.query<AgentSessionRow>(
      `insert into agent_sessions(
         id, title, status, version, created_at_ms, updated_at_ms
       ) values ($1, $2, 'active', 0, $3, $3)
       returning *`,
      [input.id, input.title ?? null, input.nowMs]
    );
    return mapAgentSessionRow(requireRow(result.rows[0], 'create session'));
  } catch (error) {
    if (isConstraint(error, 'agent_sessions_pkey')) {
      throw new AgentStoreError(
        'SESSION_ALREADY_EXISTS',
        `Session ${JSON.stringify(input.id)} already exists.`,
        { sessionId: input.id }
      );
    }
    throw error;
  }
}

export async function beginSessionDeletionCommand(
  client: PoolClient,
  input: BeginSessionDeletionInput
): Promise<BeginSessionDeletionResult> {
  return withPostgresTransaction(client, async () => {
    const sessionResult = await client.query<AgentSessionRow>(
      `select * from agent_sessions where id = $1 for update`,
      [input.sessionId]
    );
    const session = sessionResult.rows[0];
    if (!session) return { existed: false, taskFinishes: [] };

    if (session.status !== 'archived') {
      await client.query(
        `update agent_sessions
         set status = 'archived', version = version + 1, updated_at_ms = $2
         where id = $1`,
        [input.sessionId, input.nowMs]
      );
    }
    const taskResult = await client.query<AgentTaskRow>(
      `select * from agent_tasks
       where session_id = $1
         and status in ('created', 'running', 'waiting_for_user')
       order by created_at_ms, id
       for update`,
      [input.sessionId]
    );
    const taskFinishes: FinishTaskResult[] = [];
    for (const task of taskResult.rows) {
      taskFinishes.push(await cancelLockedTask(client, {
        task,
        nowMs: input.nowMs,
      }));
    }
    return { existed: true, taskFinishes };
  });
}

export async function createTaskWithUserMessageCommand(
  client: PoolClient,
  input: CreateTaskWithUserMessageInput
): Promise<CreateTaskWithUserMessageResult> {
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    try {
      const taskResult = await client.query<AgentTaskRow>(
        `insert into agent_tasks(
           id, session_id, goal_message_id, client_request_id,
           status, version, metadata, created_at_ms, updated_at_ms
         ) values ($1, $2, $3, $4, 'created', 0, $5, $6, $6)
         returning *`,
        [
          input.taskId,
          input.sessionId,
          input.userMessageId,
          input.clientRequestId ?? null,
          input.taskMetadata ?? null,
          input.nowMs,
        ]
      );
      const messageResult = await client.query<AgentMessageRow>(
        `insert into agent_messages(
           id, session_id, task_id, role, message_type, context_scope,
           visibility, channel, content, metadata, created_at_ms
         ) values (
           $1, $2, $3, 'user', 'user_message', 'conversation',
           'ui', 'normal', $4, $5, $6
         ) returning *`,
        [
          input.userMessageId,
          input.sessionId,
          input.taskId,
          input.content,
          input.messageMetadata ?? null,
          input.nowMs,
        ]
      );
      const sessionResult = await client.query<AgentSessionRow>(
        `update agent_sessions
         set version = version + 1, updated_at_ms = $2
         where id = $1
         returning *`,
        [input.sessionId, input.nowMs]
      );
      return {
        session: mapAgentSessionRow(requireRow(sessionResult.rows[0], 'touch session')),
        task: mapAgentTaskRow(requireRow(taskResult.rows[0], 'create task')),
        message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'create goal message')),
      };
    } catch (error) {
      throw mapTaskCreateError(error, input.sessionId, input.taskId, input.clientRequestId);
    }
  });
}

export async function startTaskRunCommand(
  client: PoolClient,
  input: StartTaskRunInput
): Promise<StartTaskRunResult> {
  assertFutureOwnership(input.nowMs, input.ownershipExpiresAtMs);
  return withPostgresTransaction(client, async () => {
    await lockAgentSessionForTask(client, input.taskId);
    const task = await selectTask(client, input.taskId, true);
    if (!task) throw taskNotFound(input.taskId);
    if (task.version !== input.expectedTaskVersion) {
      throw staleTaskVersion(task, input.expectedTaskVersion);
    }
    const validStart = task.status === 'created' && input.trigger === 'initial';
    if (!validStart) {
      throw new AgentStoreError(
        'INVALID_TASK_STATE',
        `Task ${JSON.stringify(task.id)} cannot start a ${input.trigger} run from ${task.status}.`,
        { taskId: task.id, status: task.status, trigger: input.trigger }
      );
    }
    const runNoResult = await client.query<{ run_no: number }>(
      `select coalesce(max(run_no), 0)::integer + 1 as run_no
       from agent_task_runs where task_id = $1`,
      [task.id]
    );
    const runNo = requireRow(runNoResult.rows[0], 'select task run number').run_no;
    const runResult = await client.query<AgentTaskRunRow>(
      `insert into agent_task_runs(
         id, task_id, run_no, trigger, status, owner_id, ownership_expires_at_ms,
         started_at_ms, updated_at_ms
       ) values ($1, $2, $3, $4, 'running', $5, $6, $7, $7)
       returning *`,
      [
        input.taskRunId,
        task.id,
        runNo,
        input.trigger,
        input.ownerId,
        input.ownershipExpiresAtMs,
        input.nowMs,
      ]
    );
    const taskResult = await client.query<AgentTaskRow>(
      `update agent_tasks
       set status = 'running', version = version + 1,
           started_at_ms = coalesce(started_at_ms, $2), updated_at_ms = $2,
           error_code = null, error_message = null, error_details = null
       where id = $1
       returning *`,
      [task.id, input.nowMs]
    );
    await touchSession(client, task.session_id, input.nowMs);
    return {
      task: mapAgentTaskRow(requireRow(taskResult.rows[0], 'start task')),
      taskRun: mapAgentTaskRunRow(requireRow(runResult.rows[0], 'create task run')),
    };
  });
}

export async function renewTaskRunOwnershipCommand(
  client: PoolClient,
  input: RenewTaskRunOwnershipInput
) {
  assertFutureOwnership(input.nowMs, input.ownershipExpiresAtMs);
  const result = await client.query<AgentTaskRunRow>(
    `update agent_task_runs
     set ownership_expires_at_ms = $5, updated_at_ms = $4
     where id = $1 and task_id = $2 and status = 'running'
       and owner_id = $3 and ownership_expires_at_ms > $4
     returning *`,
    [
      input.taskRunId,
      input.taskId,
      input.ownerId,
      input.nowMs,
      input.ownershipExpiresAtMs,
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AgentStoreError(
      'TASK_OWNERSHIP_LOST',
      `TaskRun ${JSON.stringify(input.taskRunId)} ownership could not be renewed.`,
      { taskId: input.taskId, taskRunId: input.taskRunId, ownerId: input.ownerId }
    );
  }
  return mapAgentTaskRunRow(row);
}

export async function reconcileInterruptedTaskCommand(
  client: PoolClient,
  input: ReconcileInterruptedTaskInput
): Promise<ReconcileInterruptedTaskResult> {
  return withPostgresTransaction(client, async () => {
    await lockAgentSessionForTask(client, input.taskId);
    const task = await selectTask(client, input.taskId, true);
    if (!task) throw taskNotFound(input.taskId);
    if (task.version !== input.expectedTaskVersion) {
      throw staleTaskVersion(task, input.expectedTaskVersion);
    }
    const confirmations = new Map(
      input.confirmationRequests.map(item => [item.toolCallId, item])
    );
    if (confirmations.size !== input.confirmationRequests.length) {
      throw new TypeError('Side-effect confirmation ToolCall IDs must be unique.');
    }

    let taskRun: AgentTaskRunRow | undefined;
    let updatedTask: AgentTaskRow;
    let planCleared = false;
    const toolCallRows: AgentToolCallRow[] = [];
    const requestRows: AgentUserInputRequestRow[] = [];
    let terminalized: Awaited<ReturnType<typeof terminalizeTaskChildren>> = {
      toolCalls: [],
      userInputRequests: [],
    };

    if (task.status === 'created') {
      const taskResult = await client.query<AgentTaskRow>(
        `update agent_tasks
         set status = 'failed',
             error_code = 'execution_interrupted',
             error_message = 'The service restarted before this Task began execution.',
             error_details = null, version = version + 1,
             updated_at_ms = $2, completed_at_ms = $2
         where id = $1 returning *`,
        [task.id, input.nowMs]
      );
      updatedTask = requireRow(taskResult.rows[0], 'fail undispatched task');
      planCleared = await clearActivePlan(client, task.session_id, task.id);
    } else if (task.status === 'running') {
      const runResult = await client.query<AgentTaskRunRow>(
        `select * from agent_task_runs
         where task_id = $1 and status = 'running'
         for update`,
        [task.id]
      );
      taskRun = runResult.rows[0];
      if (!taskRun || Number(taskRun.ownership_expires_at_ms) > input.nowMs) {
        throw new AgentStoreError(
          'INVALID_TASK_STATE',
          `Task ${JSON.stringify(task.id)} still has a live execution owner.`,
          { taskId: task.id, taskRunId: taskRun?.id }
        );
      }
      const runUpdate = await client.query<AgentTaskRunRow>(
        `update agent_task_runs
         set status = 'interrupted', owner_id = null, ownership_expires_at_ms = null,
             error_code = 'execution_interrupted',
             error_message = 'The execution owner stopped before the Task completed.',
             error_details = null, updated_at_ms = $2, ended_at_ms = $2
         where id = $1 returning *`,
        [taskRun.id, input.nowMs]
      );
      taskRun = requireRow(runUpdate.rows[0], 'interrupt task run');

      const runningCallsResult = await client.query<AgentToolCallRow>(
        `select *
         from agent_tool_calls
         where task_id = $1 and status = 'running'
         order by id
         for update`,
        [task.id]
      );
      const unknownCalls: AgentToolCallRow[] = [];
      for (const call of runningCallsResult.rows) {
        const sideEffectUnknown = call.side_effect_level === 'side_effecting';
        const errorCode = sideEffectUnknown
          ? 'side_effect_outcome_unknown'
          : 'execution_interrupted';
        const errorMessage = sideEffectUnknown
          ? 'The process stopped after the side-effecting tool began; its outcome is unknown.'
          : 'The tool execution was interrupted before a result was committed.';
        const callResult = await client.query<AgentToolCallRow>(
          `update agent_tool_calls
           set status = $2, error_code = $3, error_message = $4, error_details = null,
               version = version + 1,
               completed_at_ms = case when $2::text = 'failed' then $5::bigint else null end,
               updated_at_ms = $5
           where id = $1 returning *`,
          [
            call.id,
            sideEffectUnknown ? 'outcome_unknown' : 'failed',
            errorCode,
            errorMessage,
            input.nowMs,
          ]
        );
        toolCallRows.push(requireRow(callResult.rows[0], 'reconcile interrupted tool call'));
        if (!sideEffectUnknown) continue;
        unknownCalls.push(call);
      }

      terminalized = await terminalizeTaskChildren(client, {
        taskId: task.id,
        phase: 'failed',
        nowMs: input.nowMs,
      });
      for (const call of unknownCalls) {
        const confirmation = confirmations.get(call.id);
        if (!confirmation) {
          throw new AgentStoreError(
            'CONCURRENCY_CONFLICT',
            `No confirmation request ID was allocated for ToolCall ${JSON.stringify(call.id)}.`,
            { taskId: task.id, toolCallId: call.id }
          );
        }
        const requestResult = await client.query<AgentUserInputRequestRow>(
          `insert into agent_user_input_requests(
             id, session_id, task_id, tool_call_id, kind, status,
             title, prompt, input_schema,
             version, metadata, created_at_ms, updated_at_ms
           ) values (
             $1, $2, $3, $4, 'side_effect_confirmation', 'pending',
             $5, $6, $7,
             0, $8, $9, $9
           ) returning *`,
          [
            confirmation.requestId,
            task.session_id,
            task.id,
            call.id,
            confirmation.title,
            confirmation.prompt,
            JSON.stringify(confirmation.inputSchema),
            confirmation.metadata ?? null,
            input.nowMs,
          ]
        );
        requestRows.push(requireRow(requestResult.rows[0], 'create side-effect confirmation'));
      }
      if (requestRows.length > 0) {
        const taskResult = await client.query<AgentTaskRow>(
          `update agent_tasks
           set status = 'waiting_for_user',
               error_code = 'side_effect_outcome_unknown',
               error_message = 'A side-effecting tool outcome requires user confirmation.',
               error_details = null, version = version + 1, updated_at_ms = $2
           where id = $1 returning *`,
          [task.id, input.nowMs]
        );
        updatedTask = requireRow(taskResult.rows[0], 'wait for side-effect confirmation');
      } else {
        const taskResult = await client.query<AgentTaskRow>(
          `update agent_tasks
           set status = 'failed',
               error_code = 'execution_interrupted',
               error_message = 'The service restarted before this Task completed.',
               error_details = null, version = version + 1,
               updated_at_ms = $2, completed_at_ms = $2
           where id = $1 returning *`,
          [task.id, input.nowMs]
        );
        updatedTask = requireRow(taskResult.rows[0], 'fail interrupted task');
        planCleared = await clearActivePlan(client, task.session_id, task.id);
      }
    } else {
      throw new AgentStoreError(
        'INVALID_TASK_STATE',
        `Task ${JSON.stringify(task.id)} cannot be reconciled from ${task.status}.`,
        { taskId: task.id, status: task.status }
      );
    }

    await touchSession(client, task.session_id, input.nowMs);
    return {
      task: mapAgentTaskRow(updatedTask),
      ...(taskRun ? { taskRun: mapAgentTaskRunRow(taskRun) } : {}),
      toolCalls: [
        ...toolCallRows.map(mapAgentToolCallRow),
        ...terminalized.toolCalls,
      ],
      userInputRequests: [
        ...requestRows.map(mapAgentUserInputRequestRow),
        ...terminalized.userInputRequests,
      ],
      planCleared,
    };
  });
}

export async function failTaskCommand(
  client: PoolClient,
  input: FailTaskInput
): Promise<FinishTaskResult> {
  return withPostgresTransaction(client, async () => {
    await lockAgentSessionForTask(client, input.taskId);
    const task = await selectTask(client, input.taskId, true);
    if (!task) throw taskNotFound(input.taskId);
    if (task.version !== input.expectedTaskVersion) {
      throw staleTaskVersion(task, input.expectedTaskVersion);
    }
    const taskRun = await selectTaskRun(client, input.taskRunId, true);
    assertTaskRunOwnership(task, taskRun, input.ownerId, input.nowMs);
    const runResult = await client.query<AgentTaskRunRow>(
      `update agent_task_runs
       set status = 'failed', owner_id = null, ownership_expires_at_ms = null,
           error_code = $2, error_message = $3, error_details = $4,
           updated_at_ms = $5, ended_at_ms = $5
       where id = $1 returning *`,
      [
        taskRun.id,
        input.error.code,
        input.error.message,
        input.error.details === undefined ? null : JSON.stringify(input.error.details),
        input.nowMs,
      ]
    );
    const children = await terminalizeTaskChildren(client, {
      taskId: task.id,
      phase: 'failed',
      nowMs: input.nowMs,
    });
    const taskResult = await client.query<AgentTaskRow>(
      `update agent_tasks
       set status = 'failed', error_code = $2, error_message = $3, error_details = $4,
           version = version + 1, updated_at_ms = $5, completed_at_ms = $5
       where id = $1 returning *`,
      [
        task.id,
        input.error.code,
        input.error.message,
        input.error.details === undefined ? null : JSON.stringify(input.error.details),
        input.nowMs,
      ]
    );
    const planCleared = await clearActivePlan(client, task.session_id, task.id);
    await touchSession(client, task.session_id, input.nowMs);
    return {
      task: mapAgentTaskRow(requireRow(taskResult.rows[0], 'fail task')),
      taskRun: mapAgentTaskRunRow(requireRow(runResult.rows[0], 'fail task run')),
      ...children,
      planCleared,
    };
  });
}

export async function cancelTaskCommand(
  client: PoolClient,
  input: CancelTaskInput
): Promise<FinishTaskResult> {
  return withPostgresTransaction(client, async () => {
    await lockAgentSessionForTask(client, input.taskId);
    const task = await selectTask(client, input.taskId, true);
    if (!task) throw taskNotFound(input.taskId);
    if (task.version !== input.expectedTaskVersion) {
      throw staleTaskVersion(task, input.expectedTaskVersion);
    }
    const wasTerminal = ['completed', 'failed', 'cancelled'].includes(task.status);
    const result = await cancelLockedTask(client, { task, nowMs: input.nowMs });
    if (!wasTerminal) await touchSession(client, task.session_id, input.nowMs);
    return result;
  });
}

async function clearActivePlan(
  client: PoolClient,
  sessionId: string,
  taskId: string
): Promise<boolean> {
  const result = await client.query(
    `delete from agent_active_plans where session_id = $1 and task_id = $2`,
    [sessionId, taskId]
  );
  return result.rowCount === 1;
}

function staleTaskVersion(task: AgentTaskRow, expectedVersion: number): AgentStoreError {
  return new AgentStoreError(
    'CONCURRENCY_CONFLICT',
    `Task ${JSON.stringify(task.id)} version is stale.`,
    { taskId: task.id, expectedVersion, actualVersion: task.version }
  );
}

function mapTaskCreateError(
  error: unknown,
  sessionId: string,
  taskId: string,
  clientRequestId?: string
): unknown {
  if (isConstraint(error, 'uniq_agent_tasks_active_session')) {
    return new AgentStoreError(
      'ACTIVE_TASK_CONFLICT',
      `Session ${JSON.stringify(sessionId)} already has an active Task.`,
      { sessionId }
    );
  }
  if (isConstraint(error, 'uniq_agent_tasks_client_request')) {
    return new AgentStoreError(
      'CLIENT_REQUEST_CONFLICT',
      `clientRequestId ${JSON.stringify(clientRequestId)} already exists in this Session.`,
      { sessionId, clientRequestId }
    );
  }
  if (isConstraint(error, 'agent_tasks_pkey')) {
    return new AgentStoreError(
      'TASK_ALREADY_EXISTS',
      `Task ${JSON.stringify(taskId)} already exists.`,
      { taskId }
    );
  }
  return error;
}
