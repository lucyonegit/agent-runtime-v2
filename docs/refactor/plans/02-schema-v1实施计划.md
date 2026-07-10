# Canonical PostgreSQL Schema V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将设计 06 的 Job + StepRun canonical schema 真实实现为可事务应用、可版本校验、可安全 reset、并由 PostgreSQL 约束测试证明的数据基线。

**Architecture:** `schema-v1.ts` 只包含不可变 V1 DDL、checksum 和单事务 apply/reset 函数；正常启动未来只通过 `migrations.ts` 校验版本，不自动修改 schema。测试为每个 case 创建独立 PostgreSQL schema，直接验证数据库约束而不是只检查生成 SQL 字符串。

**Tech Stack:** TypeScript、pg、PostgreSQL 17、Vitest、Docker Compose。

---

### Task 1: Implement transactional Schema V1

**Files:**

- Create: `src/storage/postgres/schema-v1.ts`
- Create: `src/storage/postgres/index.ts`
- Create: `tests/postgres-schema-v1.test.ts`
- Modify: `scripts/test-postgres.sh`

- [ ] **Step 1: Write a failing schema inventory test**

The test creates a random PostgreSQL schema, calls `applyAgentRuntimeSchemaV1(client, now)`, and expects exactly these 13 tables:

```ts
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
```

- [ ] **Step 2: Run PostgreSQL tests and verify the missing module failure**

```bash
npm run test:postgres
```

Expected: FAIL because `src/storage/postgres/schema-v1.ts` does not exist.

- [ ] **Step 3: Implement the exact V1 DDL**

Copy the canonical table definitions, checks, foreign keys and indexes from `docs/refactor/06-完整Job-StepRun架构设计.md` sections 8.2–8.14 into one exported `AGENT_RUNTIME_SCHEMA_V1_SQL` constant. Do not reintroduce `agent_tasks`, `seq`, metadata relationships, child-task foreign keys, or FileSessionStore structures.

- [ ] **Step 4: Implement transactional apply**

```ts
export async function applyAgentRuntimeSchemaV1(
  client: PoolClient,
  appliedAtMs: number
): Promise<void> {
  await client.query('begin');
  try {
    await client.query(AGENT_RUNTIME_SCHEMA_V1_SQL);
    await client.query(
      `insert into agent_schema_versions(version, name, checksum, applied_at_ms)
       values ($1, $2, $3, $4)
       on conflict (version) do nothing`,
      [1, 'job-step-run-canonical', AGENT_RUNTIME_SCHEMA_V1_CHECKSUM, appliedAtMs]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
```

- [ ] **Step 5: Make the PostgreSQL runner execute every postgres test file**

Replace the final Vitest command in `scripts/test-postgres.sh` with:

```bash
DATABASE_URL="$DATABASE_URL" \
  ./node_modules/.bin/vitest run --exclude 'dist/**' 'tests/postgres*.test.ts'
```

- [ ] **Step 6: Run inventory, typecheck, and build**

```bash
npm run test:postgres
npm run typecheck
npm run build
```

Expected: 13-table inventory test and all ReAct/domain tests PASS.

- [ ] **Step 7: Commit Schema V1**

```bash
git add src/storage/postgres tests/postgres-schema-v1.test.ts scripts/test-postgres.sh
git commit -m "feat: add canonical postgres schema v1"
```

### Task 2: Prove workflow and protocol constraints

**Files:**

- Modify: `tests/postgres-schema-v1.test.ts`

- [ ] **Step 1: Add active Job and StepRun conflict tests**

Insert fixtures for one Session/Job/Plan/PlanStep and assert PostgreSQL rejects:

```text
second active Job in one Session
second active StepRun for one PlanStep
second active StepRun for one Job
duplicate (step_id, run_no)
```

- [ ] **Step 2: Add message and tool protocol constraint tests**

Assert PostgreSQL rejects a `tool_call` message without a non-empty JSON array, a `tool_result` without tool_call_id/tool_name/result, and an answered input without answer_message/client_answer/answered_at.

- [ ] **Step 3: Add model-call and summary uniqueness tests**

Assert only one started row exists for `(job_id, logical_call_key)` and only one active ContextSummary exists for one owner/purpose/rules/type tuple.

- [ ] **Step 4: Run tests repeatedly**

```bash
for run in 1 2 3; do npm run test:postgres; done
```

Expected: all three runs PASS and Compose cleanup leaves no container.

- [ ] **Step 5: Commit constraint coverage**

```bash
git add tests/postgres-schema-v1.test.ts
git commit -m "test: prove canonical postgres constraints"
```

### Task 3: Add version validation and explicit reset

**Files:**

- Create: `src/storage/postgres/migrations.ts`
- Create: `scripts/reset-agent-runtime-schema.ts`
- Create: `scripts/migrate-agent-runtime-schema.ts`
- Modify: `package.json`
- Modify: `tests/postgres-schema-v1.test.ts`

- [ ] **Step 1: Add failing version mismatch and reset-scope tests**

Tests must prove checksum mismatch and newer DB version fail closed, and reset removes only `agent_*` tables while preserving a fixture table named `users`.

- [ ] **Step 2: Implement `assertAgentRuntimeSchemaVersion`**

Return successfully only when version and checksum equal code constants. Throw stable errors for missing, older, newer, and checksum-mismatched schemas.

- [ ] **Step 3: Implement explicit reset and migration scripts**

Reset requires `--confirm-agent-runtime-reset` and rejects production unless `ALLOW_AGENT_RUNTIME_RESET=true`. Migration obtains one PoolClient and applies V1 transactionally.

- [ ] **Step 4: Add package commands**

```json
{
  "schema:migrate": "npm run build && node dist/scripts/migrate-agent-runtime-schema.js",
  "schema:reset": "npm run build && node dist/scripts/reset-agent-runtime-schema.js"
}
```

- [ ] **Step 5: Run complete verification and commit**

```bash
npm run typecheck
npm run build
npm run test:all
git add src/storage/postgres scripts package.json tests/postgres-schema-v1.test.ts
git commit -m "feat: add schema migration and safe reset"
```
