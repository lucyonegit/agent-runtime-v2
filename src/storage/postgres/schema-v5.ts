import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export const AGENT_RUNTIME_SCHEMA_VERSION = 5;
export const AGENT_RUNTIME_SCHEMA_NAME = 'local-workspace-process-supervision';

const AGENT_RUNTIME_SCHEMA_V5_SQL = String.raw`
drop table if exists agent_managed_processes;
`;

export const AGENT_RUNTIME_SCHEMA_V5_CHECKSUM = createHash('sha256')
  .update(AGENT_RUNTIME_SCHEMA_V5_SQL)
  .digest('hex');

/**
 * Process ids, ports and liveness belong to the local operating system, not
 * to durable Agent Runtime state. V5 removes the table introduced by V4 while
 * retaining the immutable V4 migration in schema history.
 */
export async function applyAgentRuntimeSchemaV5(
  client: PoolClient,
  appliedAtMs: number = Date.now()
): Promise<void> {
  await client.query('begin');
  try {
    await client.query(AGENT_RUNTIME_SCHEMA_V5_SQL);
    await client.query(
      `insert into agent_schema_versions(version, name, checksum, applied_at_ms)
       values ($1, $2, $3, $4)`,
      [
        AGENT_RUNTIME_SCHEMA_VERSION,
        AGENT_RUNTIME_SCHEMA_NAME,
        AGENT_RUNTIME_SCHEMA_V5_CHECKSUM,
        appliedAtMs,
      ]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
