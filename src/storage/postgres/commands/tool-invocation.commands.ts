import type { PoolClient } from 'pg';
import {
  AgentStoreError,
  type CommitModelToolCallsInput,
  type CommitModelToolCallsResult,
  type CommitToolResultInput,
  type CommitToolResultResult,
  type PrepareToolInvocationsForRecoveryInput,
  type PrepareToolInvocationsForRecoveryResult,
  type TryStartToolExecutionInput,
  type TryStartToolExecutionResult
} from '../../agent-store.js';
import {
  mapAgentArtifactRow,
  mapAgentLoopCheckpointRow,
  mapAgentMessageRow,
  mapAgentPlanStepRow,
  mapAgentToolInvocationRow,
  type AgentArtifactRow,
  type AgentJobRow,
  type AgentMessageRow,
  type AgentPlanStepRow,
  type AgentToolInvocationRow
} from '../row-mappers.js';
import { lockAgentSession, withPostgresTransaction } from '../sql.js';
import {
  appendLoopCheckpoint,
  assertJobLease,
  jobNotFound,
  mergeStringLists,
  requireRow,
  resolveActivePlanScope,
  selectJob,
  selectLatestLoopCheckpoint,
  selectToolInvocation,
  touchSession
} from './command-helpers.js';

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
    const scope = await resolveActivePlanScope(client, input.jobId);

    const messageResult = await client.query<AgentMessageRow>(
      `insert into agent_messages(
         id, session_id, job_id, plan_id, plan_step_id, attempt_id, output_id,
         role, message_type, visibility, channel, content, tool_calls, created_at_ms
       ) values (
         $1, $2, $3, $4, $5, $6, $7,
         'assistant', 'tool_call', 'ui', 'normal', $8, $9, $10
       )
       returning *`,
      [
        input.messageId,
        input.sessionId,
        input.jobId,
        scope?.planId ?? null,
        scope?.planStepId ?? null,
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
           id, session_id, job_id, plan_id, plan_step_id, attempt_id,
           call_message_id, tool_call_id, tool_name, arguments, arguments_checksum,
           side_effect_level, idempotency_key, status, version, metadata,
           created_at_ms, updated_at_ms
         ) values (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11,
           $12, $13, 'pending', 0, $14,
           $15, $15
         )
         returning *`,
        [
          invocation.invocationId,
          input.sessionId,
          input.jobId,
          scope?.planId ?? null,
          scope?.planStepId ?? null,
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
    const previousCheckpoint = await selectLatestLoopCheckpoint(client, input.jobId);
    await appendLoopCheckpoint(client, {
      sessionId: input.sessionId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      phase: 'tool_batch',
      callMessageId: input.messageId,
      iterationNo: (previousCheckpoint?.iteration_no ?? 0) + 1,
      executedToolCalls: (previousCheckpoint?.executed_tool_calls ?? 0) + input.invocations.length,
      metadata: { outputId: input.outputId },
      nowMs: input.nowMs,
    });
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'create tool-call message')),
      invocations: invocationRows.map(mapAgentToolInvocationRow),
    };
  });
}

export async function tryStartToolExecutionCommand(
  client: PoolClient,
  input: TryStartToolExecutionInput
): Promise<TryStartToolExecutionResult> {
  return withPostgresTransaction(client, async () => {
    const result = await client.query<AgentToolInvocationRow>(
      `update agent_tool_invocations invocation
       set status = 'running',
           attempt_id = $4,
           execution_attempt_no = invocation.execution_attempt_no + 1,
           version = invocation.version + 1,
           started_at_ms = $5,
           completed_at_ms = null,
           error_code = null,
           error_message = null,
           error_details = null,
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
      const invocation = result.rows[0];
      await client.query(
        `insert into agent_tool_execution_attempts(
           id, invocation_id, job_id, job_attempt_id, attempt_no,
           worker_id, status, started_at_ms
         ) values ($1, $2, $3, $4, $5, $6, 'running', $7)`,
        [
          `${invocation.id}:execution:${invocation.execution_attempt_no}`,
          invocation.id,
          input.jobId,
          input.attemptId,
          invocation.execution_attempt_no,
          input.workerId,
          input.nowMs,
        ]
      );
      return { invocation: mapAgentToolInvocationRow(invocation), started: true };
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
      return { invocation: mapAgentToolInvocationRow(invocation), started: false };
    }
    throw new AgentStoreError(
      'INVALID_TOOL_INVOCATION_STATE',
      `Tool invocation ${JSON.stringify(input.toolCallId)} cannot start execution from status ${invocation.status}.`,
      { jobId: input.jobId, toolCallId: input.toolCallId, status: invocation.status }
    );
  });
}

export async function prepareToolInvocationsForRecoveryCommand(
  client: PoolClient,
  input: PrepareToolInvocationsForRecoveryInput
): Promise<PrepareToolInvocationsForRecoveryResult> {
  return withPostgresTransaction(client, async () => {
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 for update`,
      [input.jobId]
    );
    const job = requireRow(jobResult.rows[0], 'lock job for tool recovery');
    assertJobLease(job, input.workerId, input.attemptId, input.nowMs);
    let checkpoint = await selectLatestLoopCheckpoint(client, input.jobId);
    let callMessageId = checkpoint?.phase === 'tool_batch'
      ? checkpoint.call_message_id
      : undefined;

    // Existing V1 Jobs have no checkpoint. Adopt their latest incomplete tool
    // batch once during migration instead of discarding durable work.
    if (!callMessageId) {
      const legacyBatch = await client.query<{ call_message_id: string }>(
        `select call_message_id
         from agent_tool_invocations
         where job_id = $1
           and status not in ('completed', 'failed', 'cancelled')
         order by created_at_ms desc, id desc
         limit 1`,
        [input.jobId]
      );
      callMessageId = legacyBatch.rows[0]?.call_message_id;
      if (callMessageId) {
        checkpoint = await appendLoopCheckpoint(client, {
          sessionId: job.session_id,
          jobId: job.id,
          attemptId: input.attemptId,
          phase: 'tool_batch',
          callMessageId,
          iterationNo: checkpoint?.iteration_no ?? 0,
          executedToolCalls: checkpoint?.executed_tool_calls ?? 0,
          metadata: { adoptedLegacyBatch: true },
          nowMs: input.nowMs,
        });
      }
    }

    if (!callMessageId) {
      return {
        checkpoint: checkpoint ? mapAgentLoopCheckpointRow(checkpoint) : undefined,
        invocations: [],
        blockedInvocations: [],
      };
    }

    const result = await client.query<AgentToolInvocationRow>(
      `select *
       from agent_tool_invocations
       where job_id = $1 and call_message_id = $2
       order by created_at_ms asc, id asc
       for update`,
      [input.jobId, callMessageId]
    );
    const recoveredRows: AgentToolInvocationRow[] = [];
    const blockedRows: AgentToolInvocationRow[] = [];
    for (const invocation of result.rows) {
      if (['completed', 'failed'].includes(invocation.status)) {
        recoveredRows.push(invocation);
        continue;
      }
      if (invocation.status === 'running') {
        const unsafe = invocation.side_effect_level === 'side_effecting';
        await client.query(
          `update agent_tool_execution_attempts
           set status = $3,
               error_code = $4,
               error_message = $5,
               completed_at_ms = $6
           where invocation_id = $1 and attempt_no = $2 and status = 'running'`,
          [
            invocation.id,
            invocation.execution_attempt_no,
            unsafe ? 'unknown' : 'interrupted',
            unsafe ? 'side_effect_status_unknown' : 'execution_interrupted',
            unsafe
              ? 'The process exited before the side effect outcome was committed.'
              : 'The tool execution owner exited before committing a result.',
            input.nowMs,
          ]
        );
        if (unsafe) {
          const unknown = await client.query<AgentToolInvocationRow>(
            `update agent_tool_invocations
             set status = 'unknown',
                 error_code = 'side_effect_status_unknown',
                 error_message = 'The process exited before the side effect outcome was committed.',
                 version = version + 1,
                 updated_at_ms = $2
             where id = $1
             returning *`,
            [invocation.id, input.nowMs]
          );
          blockedRows.push(requireRow(unknown.rows[0], 'mark unsafe invocation unknown'));
          continue;
        }
      }
      if (invocation.status === 'pending' || invocation.status === 'running') {
        const pending = await client.query<AgentToolInvocationRow>(
          `update agent_tool_invocations
           set status = 'pending',
               attempt_id = $2,
               version = version + 1,
               updated_at_ms = $3
           where id = $1
           returning *`,
          [invocation.id, input.attemptId, input.nowMs]
        );
        recoveredRows.push(requireRow(pending.rows[0], 'prepare invocation retry'));
        continue;
      }
      blockedRows.push(invocation);
    }
    return {
      checkpoint: checkpoint ? mapAgentLoopCheckpointRow(checkpoint) : undefined,
      invocations: recoveredRows.map(mapAgentToolInvocationRow),
      blockedInvocations: blockedRows.map(mapAgentToolInvocationRow),
    };
  });
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
    const runningInAttempt = invocation.status === 'running'
      && invocation.attempt_id === input.attemptId;
    const failedBeforeExecution = invocation.status === 'pending'
      && invocation.attempt_id === input.attemptId
      && input.outcome.status === 'failed'
      && input.outcome.executionStarted === false;
    if (!runningInAttempt && !failedBeforeExecution) {
      throw new AgentStoreError(
        'INVALID_TOOL_INVOCATION_STATE',
        `Tool invocation ${JSON.stringify(input.toolCallId)} cannot commit a result in this attempt.`,
        {
          status: invocation.status,
          invocationAttemptId: invocation.attempt_id,
          executionStarted: input.outcome.status === 'failed'
            ? input.outcome.executionStarted
            : true,
        }
      );
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
         id, session_id, job_id, plan_id, plan_step_id, attempt_id,
         role, message_type, visibility, channel, content,
         tool_call_id, tool_name, tool_result, created_at_ms
       ) values (
         $1, $2, $3, $4, $5, $6,
         'tool', 'tool_result', 'ui', 'normal', $7,
         $8, $9, $10, $11
       )
       returning *`,
      [
        input.messageId,
        input.sessionId,
        input.jobId,
        invocation.plan_id,
        invocation.plan_step_id,
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
    await client.query(
      `update agent_tool_execution_attempts
       set status = $3,
           error_code = $4,
           error_message = $5,
           error_details = $6,
           completed_at_ms = $7
       where invocation_id = $1 and attempt_no = $2 and status = 'running'`,
      [
        invocation.id,
        invocation.execution_attempt_no,
        input.outcome.status,
        input.outcome.status === 'failed' ? input.outcome.code : null,
        input.outcome.status === 'failed' ? input.outcome.message : null,
        input.outcome.status === 'failed' ? input.outcome.details ?? null : null,
        input.nowMs,
      ]
    );
    const artifactRows: AgentArtifactRow[] = [];
    if (input.outcome.status === 'completed') {
      for (const artifact of input.outcome.artifacts ?? []) {
        const inserted = await client.query<AgentArtifactRow>(
          `insert into agent_artifacts(
             id, session_id, job_id, plan_id, plan_step_id,
             tool_invocation_id, result_message_id,
             kind, area, title, file_name, logical_path, storage_path,
             media_type, size, checksum, revision, metadata, created_at_ms
           ) values (
             $1, $2, $3, $4, $5,
             $6, $7,
             $8, $9, $10, $11, $12, $13,
             $14, $15, $16,
             (select coalesce(max(existing.revision), 0) + 1
                from agent_artifacts existing
               where existing.session_id = $2 and existing.logical_path = $12),
             $17, $18
           ) returning *`,
          [
            artifact.id,
            input.sessionId,
            input.jobId,
            invocation.plan_id,
            invocation.plan_step_id,
            invocation.id,
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
            artifact.metadata ?? null,
            input.nowMs,
          ]
        );
        artifactRows.push(requireRow(inserted.rows[0], 'create artifact'));
      }
      // update_plan is orchestration bookkeeping, not evidence produced by the step.
      // Only task tools may contribute durable evidence/artifacts to PlanStep.result.
      if (invocation.plan_step_id && invocation.tool_name !== 'update_plan') {
        const planStepResult = await client.query<AgentPlanStepRow>(
          `select * from agent_plan_steps where id = $1 for update`,
          [invocation.plan_step_id]
        );
        const currentStep = requireRow(planStepResult.rows[0], 'lock artifact plan step');
        const currentResult = mapAgentPlanStepRow(currentStep).result;
        await client.query(
          `update agent_plan_steps
           set result = $2,
               version = version + 1,
               updated_at_ms = $3
           where id = $1`,
          [
            invocation.plan_step_id,
            JSON.stringify({
              ...currentResult,
              evidenceMessageIds: mergeStringLists(
                currentResult?.evidenceMessageIds,
                [input.messageId]
              ),
              artifactIds: mergeStringLists(
                currentResult?.artifactIds,
                artifactRows.map(artifact => artifact.id)
              ),
            }),
            input.nowMs,
          ]
        );
      }
    }
    const remainingInBatch = await client.query<{ count: string }>(
      `select count(*)::text as count
       from agent_tool_invocations
       where call_message_id = $1
         and status not in ('completed', 'failed')`,
      [invocation.call_message_id]
    );
    if (remainingInBatch.rows[0]?.count === '0') {
      const previousCheckpoint = await selectLatestLoopCheckpoint(client, input.jobId);
      await appendLoopCheckpoint(client, {
        sessionId: input.sessionId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        phase: 'ready_for_model',
        iterationNo: previousCheckpoint?.iteration_no ?? 0,
        executedToolCalls: previousCheckpoint?.executed_tool_calls ?? 0,
        metadata: { completedCallMessageId: invocation.call_message_id },
        nowMs: input.nowMs,
      });
    }
    await touchSession(client, input.sessionId, input.nowMs);
    return {
      message: mapAgentMessageRow(requireRow(messageResult.rows[0], 'create tool-result message')),
      invocation: mapAgentToolInvocationRow(
        requireRow(updatedInvocation.rows[0], 'complete tool invocation')
      ),
      artifacts: artifactRows.map(mapAgentArtifactRow),
    };
  });
}
