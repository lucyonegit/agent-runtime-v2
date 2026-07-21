import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export const AGENT_RUNTIME_SCHEMA_VERSION = 3;
export const AGENT_RUNTIME_SCHEMA_NAME = 'explicit-job-recovery';

const AGENT_RUNTIME_SCHEMA_V3_SQL = String.raw`
alter table agent_jobs
  drop constraint agent_jobs_status_check;

alter table agent_jobs
  add constraint agent_jobs_status_check check (
    status in (
      'created',
      'running',
      'waiting_user_input',
      'resuming',
      'recovery_required',
      'completed',
      'failed',
      'cancelled'
    )
  );

drop index uniq_agent_jobs_active_session;

create unique index uniq_agent_jobs_active_session
  on agent_jobs(session_id)
  where status in (
    'created',
    'running',
    'waiting_user_input',
    'resuming',
    'recovery_required'
  );
`;

export const AGENT_RUNTIME_SCHEMA_V3_CHECKSUM = createHash('sha256')
  .update(AGENT_RUNTIME_SCHEMA_V3_SQL)
  .digest('hex');

export async function applyAgentRuntimeSchemaV3(
  client: PoolClient,
  appliedAtMs: number = Date.now()
): Promise<void> {
  await client.query('begin');
  try {
    await client.query(AGENT_RUNTIME_SCHEMA_V3_SQL);
    await client.query(
      `insert into agent_schema_versions(version, name, checksum, applied_at_ms)
       values ($1, $2, $3, $4)`,
      [
        AGENT_RUNTIME_SCHEMA_VERSION,
        AGENT_RUNTIME_SCHEMA_NAME,
        AGENT_RUNTIME_SCHEMA_V3_CHECKSUM,
        appliedAtMs,
      ]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
