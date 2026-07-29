import type { PoolClient } from 'pg';
import type {
  AgentToolCall,
  AgentUserInputRequest,
} from '../../../domain/index.js';
import { AgentStoreError, type FinishTaskResult } from '../../agent-store.js';
import {
  mapAgentTaskRow,
  mapAgentTaskRunRow,
  mapAgentToolCallRow,
  mapAgentUserInputRequestRow,
  type AgentTaskRow,
  type AgentTaskRunRow,
  type AgentToolCallRow,
  type AgentUserInputRequestRow,
} from '../row-mappers.js';

export interface TerminalizedTaskChildren {
  toolCalls: AgentToolCall[];
  userInputRequests: AgentUserInputRequest[];
}

export async function terminalizeTaskChildren(
  client: PoolClient,
  input: {
    taskId: string;
    phase: 'failed' | 'cancelled';
    nowMs: number;
  }
): Promise<TerminalizedTaskChildren> {
  const parentErrorCode = input.phase === 'failed' ? 'task_failed' : 'task_cancelled';
  const parentErrorMessage = input.phase === 'failed'
    ? 'The Task failed before this tool completed.'
    : 'The Task was cancelled before this tool completed.';
  const unknownMessage = input.phase === 'failed'
    ? 'The Task failed after the side-effecting tool started; its outcome is unknown.'
    : 'The Task was cancelled after the side-effecting tool started; its outcome is unknown.';

  const callResult = await client.query<AgentToolCallRow>(
    `update agent_tool_calls
     set status = case
           when side_effect_level = 'side_effecting' and started_at_ms is not null
             then 'outcome_unknown'
           else 'cancelled'
         end,
         error_code = case
           when side_effect_level = 'side_effecting' and started_at_ms is not null
             then 'side_effect_outcome_unknown'
           else $3
         end,
         error_message = case
           when side_effect_level = 'side_effecting' and started_at_ms is not null then $4
           else $5
         end,
         error_details = null,
         version = version + 1,
         completed_at_ms = case
           when side_effect_level = 'side_effecting' and started_at_ms is not null then null::bigint
           else $2::bigint
         end,
         updated_at_ms = $2
     where task_id = $1 and status in ('pending', 'running', 'waiting_for_user')
     returning *`,
    [input.taskId, input.nowMs, parentErrorCode, unknownMessage, parentErrorMessage]
  );
  const requestResult = await client.query<AgentUserInputRequestRow>(
    `update agent_user_input_requests
     set status = 'cancelled', version = version + 1, updated_at_ms = $2
     where task_id = $1 and status = 'pending'
     returning *`,
    [input.taskId, input.nowMs]
  );
  return {
    toolCalls: callResult.rows.map(mapAgentToolCallRow),
    userInputRequests: requestResult.rows.map(mapAgentUserInputRequestRow),
  };
}

export async function assertNoActiveTaskChildren(
  client: PoolClient,
  taskId: string
): Promise<void> {
  const result = await client.query<{ active: boolean }>(
    `select exists(
       select 1 from agent_tool_calls
       where task_id = $1 and status in ('pending', 'running', 'waiting_for_user')
       union all
       select 1 from agent_user_input_requests
       where task_id = $1 and status = 'pending'
     ) as active`,
    [taskId]
  );
  if (result.rows[0]?.active) {
    throw new AgentStoreError(
      'INVALID_TASK_STATE',
      `Task ${JSON.stringify(taskId)} cannot complete with active child execution state.`,
      { taskId }
    );
  }
}

export async function cancelLockedTask(
  client: PoolClient,
  input: {
    task: AgentTaskRow;
    nowMs: number;
  }
): Promise<FinishTaskResult> {
  if (['completed', 'failed', 'cancelled'].includes(input.task.status)) {
    return {
      task: mapAgentTaskRow(input.task),
      toolCalls: [],
      userInputRequests: [],
      planCleared: false,
    };
  }
  const taskRunResult = await client.query<AgentTaskRunRow>(
    `update agent_task_runs
     set status = 'cancelled', owner_id = null, ownership_expires_at_ms = null,
         updated_at_ms = $2, ended_at_ms = $2
     where task_id = $1 and status in ('running', 'paused')
     returning *`,
    [input.task.id, input.nowMs]
  );
  const children = await terminalizeTaskChildren(client, {
    taskId: input.task.id,
    phase: 'cancelled',
    nowMs: input.nowMs,
  });
  const taskResult = await client.query<AgentTaskRow>(
    `update agent_tasks
     set status = 'cancelled', version = version + 1,
         updated_at_ms = $2, completed_at_ms = $2
     where id = $1 returning *`,
    [input.task.id, input.nowMs]
  );
  const planResult = await client.query(
    `delete from agent_active_plans where session_id = $1 and task_id = $2`,
    [input.task.session_id, input.task.id]
  );
  return {
    task: mapAgentTaskRow(requireTaskRow(taskResult.rows[0], input.task.id)),
    ...(taskRunResult.rows[0] ? { taskRun: mapAgentTaskRunRow(taskRunResult.rows[0]) } : {}),
    ...children,
    planCleared: planResult.rowCount === 1,
  };
}

function requireTaskRow(row: AgentTaskRow | undefined, taskId: string): AgentTaskRow {
  if (!row) {
    throw new AgentStoreError(
      'TASK_NOT_FOUND',
      `Agent task ${JSON.stringify(taskId)} was not found while cancelling it.`,
      { taskId }
    );
  }
  return row;
}
