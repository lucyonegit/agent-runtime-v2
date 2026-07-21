import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export const AGENT_RUNTIME_SCHEMA_VERSION = 2;
export const AGENT_RUNTIME_SCHEMA_NAME = 'durable-react-checkpoints';

const AGENT_RUNTIME_SCHEMA_V2_SQL = String.raw`
create table agent_loop_checkpoints (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  job_id text not null references agent_jobs(id) on delete cascade,
  attempt_id text not null,
  sequence_no integer not null check (sequence_no > 0),
  phase text not null check (
    phase in (
      'ready_for_model',
      'tool_batch',
      'waiting_user_input',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  call_message_id text references agent_messages(id) on delete restrict,
  iteration_no integer not null check (iteration_no >= 0),
  executed_tool_calls integer not null check (executed_tool_calls >= 0),
  metadata jsonb,
  created_at_ms bigint not null,
  unique (job_id, sequence_no),
  check (
    (phase in ('tool_batch', 'waiting_user_input') and call_message_id is not null)
    or (phase not in ('tool_batch', 'waiting_user_input') and call_message_id is null)
  )
);

create index idx_agent_loop_checkpoints_latest
  on agent_loop_checkpoints(job_id, sequence_no desc);

create table agent_tool_execution_attempts (
  id text primary key,
  invocation_id text not null references agent_tool_invocations(id) on delete cascade,
  job_id text not null references agent_jobs(id) on delete cascade,
  job_attempt_id text not null,
  attempt_no integer not null check (attempt_no > 0),
  worker_id text not null,
  status text not null check (
    status in ('running', 'completed', 'failed', 'interrupted', 'unknown')
  ),
  error_code text,
  error_message text,
  error_details jsonb,
  started_at_ms bigint not null,
  completed_at_ms bigint,
  unique (invocation_id, attempt_no)
);

create index idx_agent_tool_execution_attempts_invocation
  on agent_tool_execution_attempts(invocation_id, attempt_no asc);

alter table agent_tool_invocations
  add column execution_attempt_no integer not null default 0 check (execution_attempt_no >= 0);
`;

export const AGENT_RUNTIME_SCHEMA_V2_CHECKSUM = createHash('sha256')
  .update(AGENT_RUNTIME_SCHEMA_V2_SQL)
  .digest('hex');

export async function applyAgentRuntimeSchemaV2(
  client: PoolClient,
  appliedAtMs: number = Date.now()
): Promise<void> {
  await client.query('begin');
  try {
    await client.query(AGENT_RUNTIME_SCHEMA_V2_SQL);
    await client.query(
      `insert into agent_schema_versions(version, name, checksum, applied_at_ms)
       values ($1, $2, $3, $4)`,
      [
        AGENT_RUNTIME_SCHEMA_VERSION,
        AGENT_RUNTIME_SCHEMA_NAME,
        AGENT_RUNTIME_SCHEMA_V2_CHECKSUM,
        appliedAtMs,
      ]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
