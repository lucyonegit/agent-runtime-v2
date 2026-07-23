import type { PoolClient } from 'pg';
import {
  AGENT_RUNTIME_SCHEMA_V1_CHECKSUM,
  applyAgentRuntimeSchemaV1,
} from './schema-v1.js';
import {
  AGENT_RUNTIME_SCHEMA_NAME as AGENT_RUNTIME_SCHEMA_V2_NAME,
  AGENT_RUNTIME_SCHEMA_V2_CHECKSUM,
  AGENT_RUNTIME_SCHEMA_VERSION as AGENT_RUNTIME_SCHEMA_V2_VERSION,
  applyAgentRuntimeSchemaV2,
} from './schema-v2.js';
import {
  AGENT_RUNTIME_SCHEMA_NAME as AGENT_RUNTIME_SCHEMA_V3_NAME,
  AGENT_RUNTIME_SCHEMA_V3_CHECKSUM,
  AGENT_RUNTIME_SCHEMA_VERSION as AGENT_RUNTIME_SCHEMA_V3_VERSION,
  applyAgentRuntimeSchemaV3,
} from './schema-v3.js';
import {
  AGENT_RUNTIME_SCHEMA_NAME as AGENT_RUNTIME_SCHEMA_V4_NAME,
  AGENT_RUNTIME_SCHEMA_V4_CHECKSUM,
  AGENT_RUNTIME_SCHEMA_VERSION as AGENT_RUNTIME_SCHEMA_V4_VERSION,
  applyAgentRuntimeSchemaV4,
} from './schema-v4.js';
import {
  AGENT_RUNTIME_SCHEMA_NAME,
  AGENT_RUNTIME_SCHEMA_V5_CHECKSUM,
  AGENT_RUNTIME_SCHEMA_VERSION,
  applyAgentRuntimeSchemaV5,
} from './schema-v5.js';

type AgentRuntimeSchemaErrorCode =
  | 'AGENT_RUNTIME_SCHEMA_MISSING'
  | 'AGENT_RUNTIME_SCHEMA_OLDER'
  | 'AGENT_RUNTIME_SCHEMA_NEWER'
  | 'AGENT_RUNTIME_SCHEMA_CHECKSUM_MISMATCH'
  | 'AGENT_RUNTIME_SCHEMA_NAME_MISMATCH';

class AgentRuntimeSchemaError extends Error {
  readonly code: AgentRuntimeSchemaErrorCode;

  constructor(code: AgentRuntimeSchemaErrorCode, message: string) {
    super(message);
    this.name = 'AgentRuntimeSchemaError';
    this.code = code;
  }
}

export interface AgentRuntimeSchemaVersionRecord {
  version: number;
  name: string;
  checksum: string;
  appliedAtMs: number;
}

interface SchemaVersionRow {
  version: number;
  name: string;
  checksum: string;
  applied_at_ms: string;
}

/**
 * Normal runtime startup guard. This function is deliberately read-only:
 * startup must never guess, migrate, backfill, or reset a production schema.
 */
export async function assertAgentRuntimeSchemaVersion(
  client: PoolClient
): Promise<AgentRuntimeSchemaVersionRecord> {
  if (!await hasSchemaVersionTable(client)) {
    throw new AgentRuntimeSchemaError(
      'AGENT_RUNTIME_SCHEMA_MISSING',
      'Agent Runtime schema is missing; run the explicit schema migration command.'
    );
  }

  const result = await client.query<SchemaVersionRow>(
    `select version, name, checksum, applied_at_ms
     from agent_schema_versions
     order by version desc
     limit 1`
  );
  const row = result.rows[0];
  if (!row) {
    throw new AgentRuntimeSchemaError(
      'AGENT_RUNTIME_SCHEMA_MISSING',
      'Agent Runtime schema has no version record; run the explicit schema migration command.'
    );
  }

  if (row.version < AGENT_RUNTIME_SCHEMA_VERSION) {
    throw new AgentRuntimeSchemaError(
      'AGENT_RUNTIME_SCHEMA_OLDER',
      `Agent Runtime schema version ${row.version} is older than code version ${AGENT_RUNTIME_SCHEMA_VERSION}; migration is required.`
    );
  }
  if (row.version > AGENT_RUNTIME_SCHEMA_VERSION) {
    throw new AgentRuntimeSchemaError(
      'AGENT_RUNTIME_SCHEMA_NEWER',
      `Agent Runtime schema version ${row.version} is newer than code version ${AGENT_RUNTIME_SCHEMA_VERSION}; refusing to start.`
    );
  }
  if (row.name !== AGENT_RUNTIME_SCHEMA_NAME) {
    throw new AgentRuntimeSchemaError(
      'AGENT_RUNTIME_SCHEMA_NAME_MISMATCH',
      `Agent Runtime schema version ${row.version} has unexpected name ${JSON.stringify(row.name)}.`
    );
  }
  if (row.checksum !== AGENT_RUNTIME_SCHEMA_V5_CHECKSUM) {
    throw new AgentRuntimeSchemaError(
      'AGENT_RUNTIME_SCHEMA_CHECKSUM_MISMATCH',
      `Agent Runtime schema version ${row.version} checksum does not match the immutable migration.`
    );
  }

  return {
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAtMs: Number(row.applied_at_ms),
  };
}

/**
 * Explicit migration entrypoint. V1 can only initialize a completely blank
 * Agent Runtime schema; an existing schema must pass the read-only guard.
 */
export async function migrateAgentRuntimeSchema(
  client: PoolClient,
  appliedAtMs: number = Date.now()
): Promise<AgentRuntimeSchemaVersionRecord> {
  if (!await hasSchemaVersionTable(client)) {
    await applyAgentRuntimeSchemaV1(client, appliedAtMs);
  }
  let current = await readLatestSchemaVersion(client);
  if (current?.version === 1) {
    if (current.checksum !== AGENT_RUNTIME_SCHEMA_V1_CHECKSUM) {
      throw new AgentRuntimeSchemaError(
        'AGENT_RUNTIME_SCHEMA_CHECKSUM_MISMATCH',
        'Agent Runtime schema version 1 checksum does not match the immutable migration.'
      );
    }
    await applyAgentRuntimeSchemaV2(client, appliedAtMs);
    current = await readLatestSchemaVersion(client);
  }
  if (current?.version === AGENT_RUNTIME_SCHEMA_V2_VERSION) {
    if (
      current.name !== AGENT_RUNTIME_SCHEMA_V2_NAME
      || current.checksum !== AGENT_RUNTIME_SCHEMA_V2_CHECKSUM
    ) {
      throw new AgentRuntimeSchemaError(
        'AGENT_RUNTIME_SCHEMA_CHECKSUM_MISMATCH',
        'Agent Runtime schema version 2 does not match the immutable migration.'
      );
    }
    await applyAgentRuntimeSchemaV3(client, appliedAtMs);
    current = await readLatestSchemaVersion(client);
  }
  if (current?.version === AGENT_RUNTIME_SCHEMA_V3_VERSION) {
    if (
      current.name !== AGENT_RUNTIME_SCHEMA_V3_NAME
      || current.checksum !== AGENT_RUNTIME_SCHEMA_V3_CHECKSUM
    ) {
      throw new AgentRuntimeSchemaError(
        'AGENT_RUNTIME_SCHEMA_CHECKSUM_MISMATCH',
        'Agent Runtime schema version 3 does not match the immutable migration.'
      );
    }
    await applyAgentRuntimeSchemaV4(client, appliedAtMs);
    current = await readLatestSchemaVersion(client);
  }
  if (current?.version === AGENT_RUNTIME_SCHEMA_V4_VERSION) {
    if (
      current.name !== AGENT_RUNTIME_SCHEMA_V4_NAME
      || current.checksum !== AGENT_RUNTIME_SCHEMA_V4_CHECKSUM
    ) {
      throw new AgentRuntimeSchemaError(
        'AGENT_RUNTIME_SCHEMA_CHECKSUM_MISMATCH',
        'Agent Runtime schema version 4 does not match the immutable migration.'
      );
    }
    await applyAgentRuntimeSchemaV5(client, appliedAtMs);
  }
  return assertAgentRuntimeSchemaVersion(client);
}

/**
 * Drops only tables owned by Agent Runtime in the current PostgreSQL schema.
 * Indexes and owned sequences disappear through CASCADE; unrelated tables are
 * never selected.
 */
export async function resetAgentRuntimeSchema(client: PoolClient): Promise<string[]> {
  await client.query('begin');
  try {
    const result = await client.query<{ tablename: string }>(
      `select tablename
       from pg_catalog.pg_tables
       where schemaname = current_schema()
         and tablename like 'agent\_%' escape '\'
       order by tablename`
    );
    const tableNames = result.rows.map(row => row.tablename);
    for (const tableName of tableNames) {
      await client.query(`drop table ${quoteIdentifier(tableName)} cascade`);
    }
    await client.query('commit');
    return tableNames;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function hasSchemaVersionTable(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ relation_name: string | null }>(
    `select to_regclass('agent_schema_versions')::text as relation_name`
  );
  return result.rows[0]?.relation_name !== null;
}

async function readLatestSchemaVersion(client: PoolClient): Promise<SchemaVersionRow | undefined> {
  const result = await client.query<SchemaVersionRow>(
    `select version, name, checksum, applied_at_ms
     from agent_schema_versions
     order by version desc
     limit 1`
  );
  return result.rows[0];
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
