import { Pool, type PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAgentStore } from '../src/storage/postgres/postgres-agent-store.js';
import { applyAgentRuntimeSchemaV1 } from '../src/storage/postgres/schema-v1.js';

const databaseUrl = process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:55433/agent_runtime_test';

describe('PostgresAgentStore Job transactions', () => {
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let store: PostgresAgentStore;
  let schema: string | undefined;
  let schemaCreated = false;

  beforeEach(async () => {
    schema = `agent_store_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`create schema "${schema}"`);
    schemaCreated = true;
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const client = await pool.connect();
    try {
      await applyAgentRuntimeSchemaV1(client, 1_000);
    } finally {
      client.release();
    }
    store = new PostgresAgentStore(pool);
  });

  afterEach(async () => {
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

  it('atomically creates a Job, user message, and Session version update', async () => {
    await store.createSession({ id: 'session_create', mode: 'agent', nowMs: 10 });

    const result = await createJob(store, 'session_create', 'job_create', 'message_create', 20);

    expect(result.session).toMatchObject({ version: 1, updatedAtMs: 20 });
    expect(result.job).toMatchObject({
      id: 'job_create',
      sessionId: 'session_create',
      stage: 'routing',
      status: 'created',
      version: 0,
    });
    expect(result.message).toMatchObject({
      id: 'message_create',
      rowId: 1,
      role: 'user',
      messageType: 'user_message',
      content: 'hello job_create',
    });
  });

  it('rolls back every write when a Session already has an active Job', async () => {
    await store.createSession({ id: 'session_conflict', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_conflict', 'job_first', 'message_first', 20);

    await expect(
      createJob(store, 'session_conflict', 'job_second', 'message_second', 30)
    ).rejects.toMatchObject({ code: 'ACTIVE_JOB_CONFLICT' });

    expect(await store.getJob('job_second')).toBeUndefined();
    expect(await store.listSessionMessages('session_conflict')).toHaveLength(1);
    expect(await store.getSession('session_conflict')).toMatchObject({ version: 1, updatedAtMs: 20 });
  });

  it('allows exactly one concurrent claim and rejects stale or foreign renewals', async () => {
    await store.createSession({ id: 'session_claim', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_claim', 'job_claim', 'message_claim', 20);

    const claims = await Promise.allSettled([
      store.claimJob({
        jobId: 'job_claim',
        expectedVersion: 0,
        workerId: 'worker_a',
        attemptId: 'attempt_a',
        nowMs: 30,
        leaseUntilMs: 100,
      }),
      store.claimJob({
        jobId: 'job_claim',
        expectedVersion: 0,
        workerId: 'worker_b',
        attemptId: 'attempt_b',
        nowMs: 30,
        leaseUntilMs: 100,
      }),
    ]);
    const fulfilled = claims.filter(result => result.status === 'fulfilled');
    const rejected = claims.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CONCURRENCY_CONFLICT',
    });

    const claimed = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.claimJob>>>).value;
    await expect(store.renewJobLease({
      jobId: claimed.id,
      expectedVersion: claimed.version,
      workerId: claimed.leaseOwner!,
      attemptId: 'foreign_attempt',
      nowMs: 40,
      leaseUntilMs: 120,
    })).rejects.toMatchObject({ code: 'JOB_LEASE_LOST' });

    const renewed = await store.renewJobLease({
      jobId: claimed.id,
      expectedVersion: claimed.version,
      workerId: claimed.leaseOwner!,
      attemptId: claimed.currentAttemptId!,
      nowMs: 40,
      leaseUntilMs: 120,
    });
    expect(renewed).toMatchObject({ version: 2, leaseExpiresAtMs: 120, attemptNo: 1 });

    const recovered = await store.claimJob({
      jobId: renewed.id,
      expectedVersion: renewed.version,
      workerId: 'worker_recovery',
      attemptId: 'attempt_recovery',
      nowMs: 121,
      leaseUntilMs: 200,
    });
    expect(recovered).toMatchObject({
      version: 3,
      attemptNo: 2,
      leaseOwner: 'worker_recovery',
      currentAttemptId: 'attempt_recovery',
    });
  });

  it('fails descendants atomically, preserves side-effect uncertainty, and creates retry as a new Job', async () => {
    await store.createSession({ id: 'session_fail', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_fail', 'job_fail', 'message_fail', 20);
    const claimed = await store.claimJob({
      jobId: 'job_fail',
      expectedVersion: 0,
      workerId: 'worker_fail',
      attemptId: 'attempt_fail',
      nowMs: 30,
      leaseUntilMs: 100,
    });
    await seedRunningDescendants(pool!, claimed.currentAttemptId!);

    const failed = await store.failJob({
      jobId: claimed.id,
      expectedVersion: claimed.version,
      workerId: claimed.leaseOwner!,
      attemptId: claimed.currentAttemptId!,
      error: { code: 'model_failed', message: 'model unavailable' },
      nowMs: 40,
    });
    expect(failed).toMatchObject({
      status: 'failed',
      version: 2,
      completedAtMs: 40,
      error: { code: 'model_failed' },
    });
    expect(failed).not.toHaveProperty('leaseOwner');

    const descendantStates = await pool!.query(
      `select
         (select status from agent_plans where id = 'plan_fail') as plan_status,
         (select status from agent_plan_steps where id = 'step_fail') as step_status,
         (select status from agent_step_runs where id = 'run_fail') as run_status,
         (select status from agent_tool_invocations where id = 'invocation_side') as side_status,
         (select error_code from agent_tool_invocations where id = 'invocation_side') as side_error_code,
         (select status from agent_tool_invocations where id = 'invocation_read') as read_status,
         (select status from agent_user_input_requests where id = 'input_fail') as input_status`
    );
    expect(descendantStates.rows[0]).toEqual({
      plan_status: 'failed',
      step_status: 'failed',
      run_status: 'failed',
      side_status: 'unknown',
      side_error_code: 'side_effect_status_unknown',
      read_status: 'cancelled',
      input_status: 'cancelled',
    });

    const retry = await store.createJobAndAppendUserMessage({
      sessionId: 'session_fail',
      jobId: 'job_retry',
      retryOfJobId: 'job_fail',
      userMessageId: 'message_retry',
      content: 'retry',
      nowMs: 50,
    });
    expect(retry.job).toMatchObject({
      id: 'job_retry',
      retryOfJobId: 'job_fail',
      status: 'created',
    });
  });

  it('cancels a created Job without requiring a lease', async () => {
    await store.createSession({ id: 'session_cancel', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_cancel', 'job_cancel', 'message_cancel', 20);

    await expect(store.cancelJob({
      jobId: 'job_cancel',
      expectedVersion: 0,
      nowMs: 30,
    })).resolves.toMatchObject({
      status: 'cancelled',
      version: 1,
      completedAtMs: 30,
    });
  });
});

async function createJob(
  store: PostgresAgentStore,
  sessionId: string,
  jobId: string,
  userMessageId: string,
  nowMs: number
) {
  return store.createJobAndAppendUserMessage({
    sessionId,
    jobId,
    userMessageId,
    content: `hello ${jobId}`,
    nowMs,
  });
}

async function seedRunningDescendants(pool: Pool, attemptId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `insert into agent_plans(
         id, session_id, job_id, title, goal, status, version, created_at_ms, updated_at_ms
       ) values ('plan_fail', 'session_fail', 'job_fail', 'Plan', 'Goal', 'active', 0, 31, 31)`
    );
    await client.query(
      `insert into agent_plan_steps(
         id, plan_id, position, title, instruction, status, version, created_at_ms, updated_at_ms
       ) values ('step_fail', 'plan_fail', 0, 'Step', 'Do it', 'running', 0, 32, 32)`
    );
    await client.query(
      `insert into agent_step_runs(
         id, session_id, job_id, plan_id, step_id, run_no, executor, status,
         current_attempt_id, attempt_no, version, created_at_ms, updated_at_ms, started_at_ms
       ) values (
         'run_fail', 'session_fail', 'job_fail', 'plan_fail', 'step_fail', 1,
         'agent', 'running', $1, 1, 0, 33, 33, 33
       )`,
      [attemptId]
    );
    await client.query(
      `insert into agent_messages(
         id, session_id, job_id, plan_id, step_id, step_run_id, attempt_id,
         role, message_type, visibility, channel, content, tool_calls, created_at_ms
       ) values (
         'tool_calls_fail', 'session_fail', 'job_fail', 'plan_fail', 'step_fail', 'run_fail', $1,
         'assistant', 'tool_call', 'ui', 'normal', '',
         '[{"id":"call_side","name":"write","args":{}},{"id":"call_read","name":"read","args":{}}]'::jsonb,
         34
       )`,
      [attemptId]
    );
    for (const invocation of [
      { id: 'invocation_side', toolCallId: 'call_side', tool: 'write', sideEffect: 'side_effecting' },
      { id: 'invocation_read', toolCallId: 'call_read', tool: 'read', sideEffect: 'read_only' },
    ]) {
      await insertRunningInvocation(client, invocation, attemptId);
    }
    await client.query(
      `insert into agent_user_input_requests(
         id, session_id, job_id, plan_id, step_id, step_run_id,
         source, answer_mode, status, prompt, input_schema,
         version, created_at_ms, updated_at_ms
       ) values (
         'input_fail', 'session_fail', 'job_fail', 'plan_fail', 'step_fail', 'run_fail',
         'agent', 'as_user_message', 'pending', 'Continue?', '{"type":"approval"}'::jsonb,
         0, 36, 36
       )`
    );
  } finally {
    client.release();
  }
}

async function insertRunningInvocation(
  client: PoolClient,
  invocation: { id: string; toolCallId: string; tool: string; sideEffect: string },
  attemptId: string
): Promise<void> {
  await client.query(
    `insert into agent_tool_invocations(
       id, session_id, job_id, plan_id, step_id, step_run_id, attempt_id,
       call_message_id, tool_call_id, tool_name, arguments, arguments_checksum,
       side_effect_level, idempotency_key, status, version,
       created_at_ms, started_at_ms, updated_at_ms
     ) values (
       $1, 'session_fail', 'job_fail', 'plan_fail', 'step_fail', 'run_fail', $2,
       'tool_calls_fail', $3, $4, '{}'::jsonb, $1,
       $5, $1, 'running', 0,
       35, 35, 35
     )`,
    [invocation.id, attemptId, invocation.toolCallId, invocation.tool, invocation.sideEffect]
  );
}
