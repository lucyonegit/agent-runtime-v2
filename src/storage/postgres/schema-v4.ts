import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export const AGENT_RUNTIME_SCHEMA_VERSION = 4;
export const AGENT_RUNTIME_SCHEMA_NAME = 'managed-workspace-processes';

const AGENT_RUNTIME_SCHEMA_V4_SQL = String.raw`
create table agent_managed_processes (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  job_id text not null references agent_jobs(id) on delete cascade,
  tool_invocation_id text not null references agent_tool_invocations(id) on delete cascade,

  name text not null,
  command text not null,
  cwd text not null,
  status text not null check (
    status in ('starting', 'running', 'stopping', 'stopped', 'exited', 'failed', 'unknown')
  ),

  pid integer,
  process_group_id integer,
  host text not null,
  port integer not null check (port > 0 and port <= 65535),
  url text not null,
  log_path text not null,

  exit_code integer,
  exit_signal text,
  error_code text,
  error_message text,
  error_details jsonb,
  version integer not null default 0 check (version >= 0),
  metadata jsonb,

  created_at_ms bigint not null,
  started_at_ms bigint,
  updated_at_ms bigint not null,
  completed_at_ms bigint,

  check (
    (status in ('starting', 'running', 'stopping') and completed_at_ms is null)
    or (status in ('stopped', 'exited', 'failed', 'unknown') and completed_at_ms is not null)
  )
);

create unique index uniq_agent_managed_process_active_name
  on agent_managed_processes(session_id, name)
  where status in ('starting', 'running', 'stopping');

create unique index uniq_agent_managed_process_active_port
  on agent_managed_processes(host, port)
  where status in ('starting', 'running', 'stopping');

create index idx_agent_managed_processes_session
  on agent_managed_processes(session_id, created_at_ms asc, id asc);

create index idx_agent_managed_processes_active
  on agent_managed_processes(status, updated_at_ms asc)
  where status in ('starting', 'running', 'stopping');
`;

export const AGENT_RUNTIME_SCHEMA_V4_CHECKSUM = createHash('sha256')
  .update(AGENT_RUNTIME_SCHEMA_V4_SQL)
  .digest('hex');

export async function applyAgentRuntimeSchemaV4(
  client: PoolClient,
  appliedAtMs: number = Date.now()
): Promise<void> {
  await client.query('begin');
  try {
    await client.query(AGENT_RUNTIME_SCHEMA_V4_SQL);
    await client.query(
      `insert into agent_schema_versions(version, name, checksum, applied_at_ms)
       values ($1, $2, $3, $4)`,
      [
        AGENT_RUNTIME_SCHEMA_VERSION,
        AGENT_RUNTIME_SCHEMA_NAME,
        AGENT_RUNTIME_SCHEMA_V4_CHECKSUM,
        appliedAtMs,
      ]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
