import type { PoolClient } from 'pg';
import type {
  AgentTaskCheckpoint,
  AgentTaskCheckpointPhase,
  AgentToolCall,
  AgentToolRun,
  AgentUserInputRequest,
} from '../../../domain/index.js';
import { AgentStoreError } from '../../agent-store.js';
import {
  mapAgentTaskCheckpointRow,
  mapAgentToolCallRow,
  mapAgentToolRunRow,
  mapAgentUserInputRequestRow,
  type AgentToolCallRow,
  type AgentToolRunRow,
  type AgentUserInputRequestRow,
} from '../row-mappers.js';
import {
  appendTaskCheckpoint,
  selectLatestTaskCheckpoint,
} from './command-helpers.js';

export interface TerminalizedTaskChildren {
  toolCalls: AgentToolCall[];
  toolRuns: AgentToolRun[];
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

  const runResult = await client.query<AgentToolRunRow>(
    `update agent_tool_runs run
     set status = case
           when call.side_effect_level = 'side_effecting' then 'outcome_unknown'
           else 'cancelled'
         end,
         error_code = case
           when call.side_effect_level = 'side_effecting'
             then 'side_effect_outcome_unknown'
           else $3
         end,
         error_message = case
           when call.side_effect_level = 'side_effecting' then $4
           else $5
         end,
         error_details = null,
         ended_at_ms = $2,
         duration_ms = greatest(0, $2 - run.started_at_ms)
     from agent_tool_calls call
     where run.tool_call_id = call.id
       and run.task_id = $1
       and run.status = 'running'
     returning run.*`,
    [input.taskId, input.nowMs, parentErrorCode, unknownMessage, parentErrorMessage]
  );
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
    toolRuns: runResult.rows.map(mapAgentToolRunRow),
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
       select 1 from agent_tool_runs
       where task_id = $1 and status = 'running'
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

export async function appendTerminalTaskCheckpoint(
  client: PoolClient,
  input: {
    sessionId: string;
    taskId: string;
    taskRunId?: string;
    phase: Extract<AgentTaskCheckpointPhase, 'completed' | 'failed' | 'cancelled'>;
    metadata?: Record<string, unknown>;
    nowMs: number;
  }
): Promise<AgentTaskCheckpoint | undefined> {
  if (!input.taskRunId) return undefined;
  const previous = await selectLatestTaskCheckpoint(client, input.taskId);
  const checkpoint = await appendTaskCheckpoint(client, {
    sessionId: input.sessionId,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    phase: input.phase,
    iterationNo: previous?.iteration_no ?? 0,
    executedToolCalls: previous?.executed_tool_calls ?? 0,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    nowMs: input.nowMs,
  });
  return mapAgentTaskCheckpointRow(checkpoint);
}
