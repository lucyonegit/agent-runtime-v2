import { Pool, type PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  AGENT_RUNTIME_SCHEMA_V1_CHECKSUM,
  applyAgentRuntimeSchemaV1,
} from '../src/storage/postgres/schema-v1.js';
import {
  assertAgentRuntimeSchemaVersion,
  migrateAgentRuntimeSchema,
  resetAgentRuntimeSchema,
} from '../src/storage/postgres/migrations.js';

const databaseUrl = process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:55433/agent_runtime_test';

const EXPECTED_TABLES = [
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

  it('allows only one active Job per Session', async () => {
    await insertSession(client!, 'session_jobs');
    await insertJob(client!, 'job_1', 'session_jobs');

    await expect(insertJob(client!, 'job_2', 'session_jobs')).rejects.toMatchObject({ code: '23505' });

    await client!.query(
      `update agent_jobs
       set status = 'failed', completed_at_ms = 20, updated_at_ms = 20
       where id = 'job_1'`
    );
    await expect(insertJob(client!, 'job_2', 'session_jobs')).resolves.toBeUndefined();
  });

  it('allows only one active StepRun per PlanStep and per Job', async () => {
    await seedPlan(client!, 'run');
    await insertStepRun(client!, 'run_1', 'job_run', 'plan_run', 'step_run_1', 1);

    await expect(
      insertStepRun(client!, 'run_2', 'job_run', 'plan_run', 'step_run_1', 2)
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      insertStepRun(client!, 'run_3', 'job_run', 'plan_run', 'step_run_2', 1)
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects malformed tool protocol messages', async () => {
    await insertSession(client!, 'session_messages');
    await insertJob(client!, 'job_messages', 'session_messages');

    await expect(client!.query(
      `insert into agent_messages(
         id, session_id, job_id, role, message_type, visibility, content, created_at_ms
       ) values (
         'msg_bad_call', 'session_messages', 'job_messages',
         'assistant', 'tool_call', 'ui', '', 10
       )`
    )).rejects.toMatchObject({ code: '23514' });

    await expect(client!.query(
      `insert into agent_messages(
         id, session_id, job_id, role, message_type, visibility, content, created_at_ms
       ) values (
         'msg_bad_result', 'session_messages', 'job_messages',
         'tool', 'tool_result', 'ui', '', 11
       )`
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces one active summary and one started logical model call', async () => {
    await insertSession(client!, 'session_unique');
    await insertJob(client!, 'job_unique', 'session_unique');

    await insertSummary(client!, 'summary_1', 'session_unique');
    await expect(insertSummary(client!, 'summary_2', 'session_unique'))
      .rejects.toMatchObject({ code: '23505' });

    await insertModelCall(client!, 'call_1', 'job_unique', 1);
    await expect(insertModelCall(client!, 'call_2', 'job_unique', 2))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('validates the exact schema version, name, and checksum', async () => {
    await expect(assertAgentRuntimeSchemaVersion(client!)).resolves.toEqual({
      version: AGENT_RUNTIME_SCHEMA_VERSION,
      name: 'job-step-run-canonical',
      checksum: AGENT_RUNTIME_SCHEMA_V1_CHECKSUM,
      appliedAtMs: 1_000,
    });
  });

  it('fails closed for missing, older, newer, and modified schemas', async () => {
    await client!.query(
      `update agent_schema_versions set checksum = 'modified' where version = $1`,
      [AGENT_RUNTIME_SCHEMA_VERSION]
    );
    await expect(assertAgentRuntimeSchemaVersion(client!)).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_SCHEMA_CHECKSUM_MISMATCH',
    });

    await client!.query('delete from agent_schema_versions');
    await client!.query(
      `insert into agent_schema_versions(version, name, checksum, applied_at_ms)
       values (0, 'legacy', 'legacy', 1)`
    );
    await expect(assertAgentRuntimeSchemaVersion(client!)).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_SCHEMA_OLDER',
    });

    await client!.query('delete from agent_schema_versions');
    await client!.query(
      `insert into agent_schema_versions(version, name, checksum, applied_at_ms)
       values (2, 'future', 'future', 1)`
    );
    await expect(assertAgentRuntimeSchemaVersion(client!)).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_SCHEMA_NEWER',
    });

    await resetAgentRuntimeSchema(client!);
    await expect(assertAgentRuntimeSchemaVersion(client!)).rejects.toMatchObject({
      code: 'AGENT_RUNTIME_SCHEMA_MISSING',
    });
  });

  it('resets only agent-owned tables and can explicitly migrate a blank schema', async () => {
    await client!.query('create table users (id text primary key)');
    await client!.query(`insert into users(id) values ('user_1')`);

    const droppedTables = await resetAgentRuntimeSchema(client!);
    expect(droppedTables).toEqual(EXPECTED_TABLES);

    const remainingTables = await client!.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = current_schema()
       order by table_name`
    );
    expect(remainingTables.rows.map(row => row.table_name)).toEqual(['users']);
    await expect(client!.query('select id from users')).resolves.toMatchObject({
      rows: [{ id: 'user_1' }],
    });

    await expect(migrateAgentRuntimeSchema(client!, 2_000)).resolves.toMatchObject({
      version: AGENT_RUNTIME_SCHEMA_VERSION,
      checksum: AGENT_RUNTIME_SCHEMA_V1_CHECKSUM,
      appliedAtMs: 2_000,
    });
  });
});

async function insertSession(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `insert into agent_sessions(id, status, version, created_at_ms, updated_at_ms)
     values ($1, 'active', 0, 1, 1)`,
    [id]
  );
}

async function insertJob(client: PoolClient, id: string, sessionId: string): Promise<void> {
  await client.query(
    `insert into agent_jobs(
       id, session_id, stage, status, attempt_no, version, created_at_ms, updated_at_ms
     ) values ($1, $2, 'routing', 'created', 0, 0, 2, 2)`,
    [id, sessionId]
  );
}

async function seedPlan(client: PoolClient, suffix: string): Promise<void> {
  const sessionId = `session_${suffix}`;
  const jobId = `job_${suffix}`;
  const planId = `plan_${suffix}`;
  await insertSession(client, sessionId);
  await insertJob(client, jobId, sessionId);
  await client.query(
    `insert into agent_plans(
       id, session_id, job_id, title, goal, status, version, created_at_ms, updated_at_ms
     ) values ($1, $2, $3, 'Plan', 'Goal', 'active', 0, 3, 3)`,
    [planId, sessionId, jobId]
  );
  for (const position of [0, 1]) {
    await client.query(
      `insert into agent_plan_steps(
         id, plan_id, position, title, instruction, status, version, created_at_ms, updated_at_ms
       ) values ($1, $2, $3, $4, $5, 'pending', 0, 4, 4)`,
      [`step_${suffix}_${position + 1}`, planId, position, `Step ${position + 1}`, `Do ${position + 1}`]
    );
  }
}

async function insertStepRun(
  client: PoolClient,
  id: string,
  jobId: string,
  planId: string,
  stepId: string,
  runNo: number
): Promise<void> {
  await client.query(
    `insert into agent_step_runs(
       id, session_id, job_id, plan_id, step_id, run_no,
       status, attempt_no, version, created_at_ms, updated_at_ms
     ) values ($1, 'session_run', $2, $3, $4, $5, 'created', 0, 0, 5, 5)`,
    [id, jobId, planId, stepId, runNo]
  );
}

async function insertSummary(client: PoolClient, id: string, sessionId: string): Promise<void> {
  await client.query(
    `insert into agent_context_summaries(
       id, session_id, owner_type, owner_id, purpose, context_rules_version,
       summary_type, status, source_row_id_start, source_row_id_end, summary,
       summary_format, source_message_count, compression_prompt_version,
       checksum, version, created_at_ms, updated_at_ms
     ) values (
       $1, $2, 'session', $2, 'conversation', 'v1', 'rolling', 'active',
       1, 1, 'summary', 'markdown', 1, 'compress-v1', $1, 0, 6, 6
     )`,
    [id, sessionId]
  );
}

async function insertModelCall(
  client: PoolClient,
  id: string,
  jobId: string,
  callAttemptNo: number
): Promise<void> {
  await client.query(
    `insert into agent_model_calls(
       id, session_id, job_id, attempt_id, logical_call_key, call_attempt_no,
       call_type, status, provider, model, context_rules_version, input_manifest,
       input_checksum, max_context_tokens, reserved_output_tokens,
       estimated_input_tokens, usage_source, created_at_ms
     ) values (
       $1, 'session_unique', $2, 'attempt_1', 'route', $3,
       'planner.route', 'started', 'test', 'test-model', 'v1', '{}'::jsonb,
       'checksum', 1000, 100, 10, 'estimated', 7
     )`,
    [id, jobId, callAttemptNo]
  );
}
