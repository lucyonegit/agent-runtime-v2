# AgentStore 与 JobCoordinator 基础实施计划

**Goal:** 实现阶段 2 的持久化基础：稳定的 Store 契约、Session 行锁、Job version CAS、lease/attempt 校验，以及 Job 创建、失败、取消和 retry 的原子边界。

**Architecture:** `AgentStore` 只暴露领域读模型和原子命令；`PostgresAgentStore` 管理连接生命周期；`postgres/transaction-commands.ts` 在单个 `PoolClient` 上落实锁顺序和状态迁移；`row-mappers.ts` 是 SQL snake_case 到 domain camelCase 的唯一转换点。orchestration 不允许直接组合通用 CRUD。

**Tech Stack:** TypeScript、pg、PostgreSQL 17、Vitest、Docker Compose。

---

### Task 1: Store contract, errors, and row mappers

**Files:**

- Create: `src/storage/agent-store.ts`
- Create: `src/storage/postgres/row-mappers.ts`
- Create: `src/storage/postgres/sql.ts`
- Modify: `src/storage/postgres/index.ts`
- Modify: `src/index.ts`

- [ ] 定义 Session/Job/Message 的 create/read 输入输出。
- [ ] 定义稳定错误码：not found、active job conflict、concurrency conflict、invalid state、lease lost。
- [ ] mapper 统一处理 bigint、JSONB、nullable 列和嵌套 error。
- [ ] mapper 单元测试覆盖 nullable 与 bigint。

### Task 2: Atomic Job commands

**Files:**

- Create: `src/storage/postgres/transaction-commands.ts`
- Create: `src/storage/postgres/postgres-agent-store.ts`
- Create: `tests/postgres-agent-store.test.ts`

- [ ] `createSession` 与 `createJobAndAppendUserMessage`。
- [ ] 写 message 前先锁 Session；active Job 冲突时整个事务回滚。
- [ ] `claimJob` 使用 expected version、attempt ID、worker ID 和 lease deadline。
- [ ] `renewJobLease` 同时校验 version、worker、attempt 和未过期 lease。
- [ ] `failJob`/`cancelJob` 原子终止相关 Plan/StepRun/input/invocation，并保留 side-effecting unknown。
- [ ] retry 只能引用同 Session 的 failed Job，并始终创建新 Job。

### Task 3: Concurrency and rollback proof

**Files:**

- Modify: `tests/postgres-agent-store.test.ts`

- [ ] 并发 claim 只有一个成功。
- [ ] stale version 与错误 attempt 都返回稳定错误。
- [ ] 第二个 active Job 被拒绝且不留下孤立 message。
- [ ] failed Job retry 创建新 ID 和 `retry_of_job_id`。
- [ ] 完整运行 typecheck、build、普通测试和 PostgreSQL 测试后提交。
