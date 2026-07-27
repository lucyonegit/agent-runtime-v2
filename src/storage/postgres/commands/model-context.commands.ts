import type { PoolClient } from 'pg';
import {
  AgentStoreError,
  type CompleteModelCallInput,
  type CompleteModelCallResult,
  type ReplaceContextSummaryInput,
  type SetModelCallOutputDispositionInput,
  type StartModelCallInput
} from '../../agent-store.js';
import {
  mapAgentContextSummaryRow,
  mapAgentModelCallRow,
  mapAgentModelUsageStatsRow,
  type AgentContextSummaryRow,
  type AgentJobRow,
  type AgentModelCallRow,
  type AgentModelUsageStatsRow
} from '../row-mappers.js';
import { withPostgresTransaction } from '../sql.js';
import {
  appendLoopCheckpoint,
  assertJobLease,
  jobNotFound,
  requireRow,
  selectJob,
  selectLatestLoopCheckpoint
} from './command-helpers.js';

export async function startModelCallCommand(
  client: PoolClient,
  input: StartModelCallInput
) {
  const job = await selectJob(client, input.jobId);
  if (!job || job.session_id !== input.sessionId) throw jobNotFound(input.jobId);
  assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
  const result = await client.query<AgentModelCallRow>(
    `insert into agent_model_calls(
       id, session_id, job_id, attempt_id,
       logical_call_key, call_attempt_no, call_type, status,
       provider, model, context_rules_version, input_manifest, input_messages, input_checksum,
       max_context_tokens, reserved_output_tokens, estimated_input_tokens,
       usage_source, output_id, output_disposition, metadata, created_at_ms
     ) values (
       $1, $2, $3, $4,
       $5, $6, $7, 'started',
       $8, $9, $10, $11, $12, $13,
       $14, $15, $16,
       'estimated', $17, $18, $19, $20
     ) returning *`,
    [
      input.id, input.sessionId, input.jobId, input.attemptId,
      input.logicalCallKey, input.callAttemptNo, input.callType,
      input.provider, input.model, input.contextRulesVersion,
      JSON.stringify(input.inputManifest), JSON.stringify(input.inputMessages), input.inputChecksum,
      input.maxContextTokens, input.reservedOutputTokens, input.estimatedInputTokens,
      input.outputId ?? null,
      input.outputId ? 'pending' : null,
      input.metadata ?? null,
      input.nowMs,
    ]
  );
  return mapAgentModelCallRow(requireRow(result.rows[0], 'start model call'));
}

export async function setModelCallOutputDispositionCommand(
  client: PoolClient,
  input: SetModelCallOutputDispositionInput
) {
  return withPostgresTransaction(client, async () => {
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`,
      [input.jobId]
    );
    const job = requireRow(jobResult.rows[0], 'lock job for model output disposition');
    const result = await client.query<AgentModelCallRow>(
      `update agent_model_calls
       set output_disposition = $3,
           output_disposition_reason = $4
       where job_id = $1 and output_id = $2
       returning *`,
      [input.jobId, input.outputId, input.disposition, input.reason ?? null]
    );
    const call = requireRow(
      result.rows[0],
      `set disposition for ModelCall output ${JSON.stringify(input.outputId)}`
    );
    if (input.disposition === 'rejected' && job.current_attempt_id === call.attempt_id) {
      const previousCheckpoint = await selectLatestLoopCheckpoint(client, input.jobId);
      await appendLoopCheckpoint(client, {
        sessionId: job.session_id,
        jobId: job.id,
        attemptId: call.attempt_id,
        phase: 'ready_for_model',
        iterationNo: (previousCheckpoint?.iteration_no ?? 0) + 1,
        executedToolCalls: previousCheckpoint?.executed_tool_calls ?? 0,
        metadata: { rejectedOutputId: input.outputId, reason: input.reason },
        nowMs: Number(call.completed_at_ms ?? job.updated_at_ms),
      });
    }
    return mapAgentModelCallRow(call);
  });
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
           output_id = coalesce($9, output_id),
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
      `select call.*
       from agent_model_calls call
       join agent_jobs job on job.id = call.job_id
       where call.status = 'started'
         and (
           job.status not in ('running', 'resuming')
           or job.lease_expires_at_ms is null
           or job.lease_expires_at_ms <= $1
         )
       order by call.id
       for update of call`,
      [nowMs]
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
         id, session_id, job_id,
         owner_type, owner_id, purpose, context_rules_version, summary_type, status,
         source_row_id_start, source_row_id_end, parent_summary_id, replaces_summary_id,
         summary, summary_format, source_message_count, source_token_count,
         summary_token_count, model, compression_prompt_version, checksum,
         version, metadata, created_at_ms, updated_at_ms
       ) values (
         $1, $2, $3,
         $4, $5, $6, $7, $8, 'active',
         $9, $10, $11, $12,
         $13, $14, $15, $16,
         $17, $18, $19, $20,
         0, $21, $22, $22
       ) returning *`,
      [
        input.id, input.sessionId, input.jobId ?? null,
        input.ownerType, input.ownerId, input.purpose, input.contextRulesVersion,
        input.summaryType,
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
