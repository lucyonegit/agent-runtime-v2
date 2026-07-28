import type { PoolClient } from 'pg';
import {
  AgentStoreError,
  type CompleteModelCallInput,
  type CompleteModelCallResult,
  type ReplaceContextCompactionInput,
  type SetModelCallOutputDispositionInput,
  type StartModelCallInput,
} from '../../agent-store.js';
import {
  mapAgentContextCompactionRow,
  mapAgentModelCallRow,
  mapAgentModelUsageStatsRow,
  type AgentContextCompactionRow,
  type AgentModelCallRow,
  type AgentModelUsageStatsRow,
} from '../row-mappers.js';
import { lockAgentSession, withPostgresTransaction } from '../sql.js';
import {
  assertTaskRunOwnership,
  requireRow,
  selectTask,
  selectTaskRun,
  taskNotFound,
  touchSession,
} from './command-helpers.js';

export async function startModelCallCommand(
  client: PoolClient,
  input: StartModelCallInput
) {
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const task = await selectTask(client, input.taskId);
    if (!task || task.session_id !== input.sessionId) throw taskNotFound(input.taskId);
    const taskRun = await selectTaskRun(client, input.taskRunId);
    assertTaskRunOwnership(task, taskRun, input.ownerId, input.nowMs);
    const result = await client.query<AgentModelCallRow>(
      `insert into agent_model_calls(
         id, session_id, task_id, task_run_id,
         logical_call_key, call_type, status,
         provider, model, context_rules_version, input_manifest, input_messages, input_checksum,
         max_context_tokens, reserved_output_tokens, estimated_input_tokens,
         usage_source, output_id, output_disposition, metadata, created_at_ms
       ) values (
         $1, $2, $3, $4,
         $5, $6, 'started',
         $7, $8, $9, $10, $11, $12,
         $13, $14, $15,
         'estimated', $16, $17, $18, $19
       ) returning *`,
      [
        input.id,
        input.sessionId,
        input.taskId,
        input.taskRunId,
        input.logicalCallKey,
        input.callType,
        input.provider,
        input.model,
        input.contextRulesVersion,
        JSON.stringify(input.inputManifest),
        JSON.stringify(input.inputMessages),
        input.inputChecksum,
        input.maxContextTokens,
        input.reservedOutputTokens,
        input.estimatedInputTokens,
        input.outputId ?? null,
        input.outputId ? 'pending' : null,
        input.metadata ?? null,
        input.nowMs,
      ]
    );
    return mapAgentModelCallRow(requireRow(result.rows[0], 'start model call'));
  });
}

export async function setModelCallOutputDispositionCommand(
  client: PoolClient,
  input: SetModelCallOutputDispositionInput
) {
  const result = await client.query<AgentModelCallRow>(
    `update agent_model_calls
     set output_disposition = $3, output_disposition_reason = $4
     where task_id = $1 and output_id = $2
     returning *`,
    [input.taskId, input.outputId, input.disposition, input.reason ?? null]
  );
  return mapAgentModelCallRow(requireRow(
    result.rows[0],
    `set disposition for output ${JSON.stringify(input.outputId)}`
  ));
}

export async function completeModelCallCommand(
  client: PoolClient,
  input: CompleteModelCallInput
): Promise<CompleteModelCallResult> {
  return withPostgresTransaction(client, async () => {
    const candidate = await client.query<Pick<AgentModelCallRow, 'session_id'>>(
      `select session_id from agent_model_calls where id = $1`,
      [input.id]
    );
    const sessionId = requireRow(candidate.rows[0], 'find model call').session_id;
    await lockAgentSession(client, sessionId);
    const locked = await client.query<AgentModelCallRow>(
      `select * from agent_model_calls where id = $1 for update`,
      [input.id]
    );
    const call = requireRow(locked.rows[0], 'lock model call');
    if (call.status !== 'started') {
      throw new AgentStoreError(
        'CONCURRENCY_CONFLICT',
        `ModelCall ${JSON.stringify(call.id)} is already ${call.status}.`
      );
    }
    const result = await client.query<AgentModelCallRow>(
      `update agent_model_calls
       set status = $2,
           actual_input_tokens = $3, actual_output_tokens = $4, actual_total_tokens = $5,
           cache_read_input_tokens = $6, cache_write_input_tokens = $7,
           usage_source = $8, output_id = coalesce($9, output_id),
           result_type = $10, result_payload = $11, tool_names = $12,
           error_code = $13, error_message = $14, error_details = $15,
           completed_at_ms = $16
       where id = $1 returning *`,
      [
        input.id,
        input.status,
        input.actualInputTokens ?? null,
        input.actualOutputTokens ?? null,
        input.actualTotalTokens ?? null,
        input.cacheReadInputTokens ?? null,
        input.cacheWriteInputTokens ?? null,
        input.usageSource,
        input.outputId ?? null,
        input.resultType ?? null,
        input.resultPayload === undefined ? null : JSON.stringify(input.resultPayload),
        input.toolNames ? JSON.stringify(input.toolNames) : null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.errorDetails === undefined ? null : JSON.stringify(input.errorDetails),
        input.nowMs,
      ]
    );
    const usage = await upsertModelUsageStats(client, call, input);
    await touchSession(client, call.session_id, input.nowMs);
    return {
      call: mapAgentModelCallRow(requireRow(result.rows[0], 'complete model call')),
      usage: mapAgentModelUsageStatsRow(usage),
    };
  });
}

export async function abandonStartedModelCallsCommand(client: PoolClient, nowMs: number) {
  return withPostgresTransaction(client, async () => {
    const result = await client.query<AgentModelCallRow>(
      `update agent_model_calls call
       set status = 'failed', usage_source = 'unavailable',
           error_code = 'model_call_interrupted',
           error_message = 'The TaskRun ended before the model result was committed.',
           completed_at_ms = $1
       from agent_task_runs run
       where call.task_run_id = run.id
         and call.status = 'started'
         and (
           run.status <> 'running'
           or run.ownership_expires_at_ms is null
           or run.ownership_expires_at_ms <= $1
         )
       returning call.*`,
      [nowMs]
    );
    const completed = [];
    for (const call of result.rows) {
      await upsertModelUsageStats(client, call, {
        id: call.id,
        status: 'failed',
        usageSource: 'unavailable',
        errorCode: 'model_call_interrupted',
        errorMessage: 'The TaskRun ended before the model result was committed.',
        nowMs,
      });
      completed.push(mapAgentModelCallRow(call));
    }
    for (const sessionId of new Set(result.rows.map(call => call.session_id))) {
      await touchSession(client, sessionId, nowMs);
    }
    return completed;
  });
}

export async function replaceContextCompactionCommand(
  client: PoolClient,
  input: ReplaceContextCompactionInput
) {
  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const task = await selectTask(client, input.taskId);
    if (!task || task.session_id !== input.sessionId) throw taskNotFound(input.taskId);
    const taskRun = await selectTaskRun(client, input.taskRunId);
    assertTaskRunOwnership(task, taskRun, input.ownerId, input.nowMs);
    const existing = await client.query<AgentContextCompactionRow>(
      `select * from agent_context_compactions where session_id = $1 for update`,
      [input.sessionId]
    );
    const current = existing.rows[0];
    const currentVersion = current?.version ?? null;
    if (currentVersion !== input.expectedVersion) {
      throw new AgentStoreError(
        'CONCURRENCY_CONFLICT',
        'Context compaction changed after its input snapshot was read.',
        {
          sessionId: input.sessionId,
          expectedVersion: input.expectedVersion,
          actualVersion: currentVersion,
        }
      );
    }
    if (current && Number(current.through_message_row_id) >= input.throughMessageRowId) {
      throw new AgentStoreError(
        'CONCURRENCY_CONFLICT',
        'Context compaction must advance to a newer message.',
        {
          sessionId: input.sessionId,
          currentThroughMessageRowId: Number(current.through_message_row_id),
          requestedThroughMessageRowId: input.throughMessageRowId,
        }
      );
    }
    const result = await client.query<AgentContextCompactionRow>(
      `insert into agent_context_compactions(
         session_id, through_message_row_id, summary, version, updated_at_ms
       ) values ($1, $2, $3, 0, $4)
       on conflict (session_id) do update set
         through_message_row_id = excluded.through_message_row_id,
         summary = excluded.summary,
         version = agent_context_compactions.version + 1,
         updated_at_ms = excluded.updated_at_ms
       returning *`,
      [input.sessionId, input.throughMessageRowId, input.summary, input.nowMs]
    );
    return mapAgentContextCompactionRow(requireRow(result.rows[0], 'replace context compaction'));
  });
}

async function upsertModelUsageStats(
  client: PoolClient,
  call: AgentModelCallRow,
  input: CompleteModelCallInput
): Promise<AgentModelUsageStatsRow> {
  const actualInput = input.actualInputTokens ?? 0;
  const actualOutput = input.actualOutputTokens ?? 0;
  const total = input.actualTotalTokens ?? actualInput + actualOutput;
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
      call.session_id,
      call.estimated_input_tokens,
      actualInput,
      actualOutput,
      input.cacheReadInputTokens ?? 0,
      input.cacheWriteInputTokens ?? 0,
      total,
      call.id,
      call.model,
      ratio,
      call.max_context_tokens,
      warning,
      input.nowMs,
    ]
  );
  return requireRow(result.rows[0], 'update model usage stats');
}
