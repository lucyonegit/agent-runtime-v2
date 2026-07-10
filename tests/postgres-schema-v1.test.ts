import { Pool, type PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  AGENT_RUNTIME_SCHEMA_V1_CHECKSUM,
  applyAgentRuntimeSchemaV1,
} from '../src/storage/postgres/schema-v1.js';

const databaseUrl = process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:55433/agent_runtime_test';

const EXPECTED_TABLES = [
  'agent_code_projects',
  'agent_context_summaries',
  'agent_jobs',
  'agent_messages',
  'agent_model_calls',
  'agent_model_usage_stats',
  'agent_plan_steps',
  'agent_plans',
  'agent_schema_versions',
  'agent_sessions',
  'agent_step_runs',
  'agent_tool_invocations',
  'agent_user_input_requests',
];

describe('canonical PostgreSQL schema v1', () => {
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  let schema: string | undefined;
  let schemaCreated = false;

  beforeEach(async () => {
    schema = `agent_runtime_v1_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`create schema "${schema}"`);
    schemaCreated = true;
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    client = await pool.connect();
    await applyAgentRuntimeSchemaV1(client, 1_000);
  });

  afterEach(async () => {
    client?.release();
    client = undefined;
    if (pool) await pool.end();
    pool = undefined;
    if (adminPool && schema && schemaCreated) {
      await adminPool.query(`drop schema if exists "${schema}" cascade`);
    }
    if (adminPool) await adminPool.end();
    adminPool = undefined;
    schema = undefined;
    schemaCreated = false;
  });

  it('creates the exact canonical table inventory and version record', async () => {
    const tables = await client!.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = current_schema()
       order by table_name`
    );
    expect(tables.rows.map(row => row.table_name)).toEqual(EXPECTED_TABLES);

    const versions = await client!.query(
      'select version, name, checksum, applied_at_ms from agent_schema_versions'
    );
    expect(versions.rows).toEqual([{
      version: AGENT_RUNTIME_SCHEMA_VERSION,
      name: 'job-step-run-canonical',
      checksum: AGENT_RUNTIME_SCHEMA_V1_CHECKSUM,
      applied_at_ms: '1000',
    }]);
  });
});
