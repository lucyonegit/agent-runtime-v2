# Orchestration Runtime Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/07-orchestration-runtime-boundary.md` 将 Job/Plan/Step workflow 归位到 orchestration，并把 ReactExecutor 收缩为只执行已编译 Context 的 Runtime，同时保持数据库、状态机、Context v6、SSE 和 HTTP contract 不变。

**Architecture:** 分两阶段迁移。第一阶段只移动 Job lifecycle 和 workflow，确保调用链仍与当前实现一致；第二阶段新增 `ExecutionContextProvider` 承担 Context build/compression/reload，将 `ReactExecutor` 重命名为 `ReactExecutionRuntime` 并改为接收 `BuiltContext`。Server 只保留 provider/config/composition。

**Tech Stack:** TypeScript、Node.js、LangChain、NestJS、PostgreSQL、Vitest、现有 AgentStore/PlanEngine/Context v6。

---

## Frozen behavior

- 不修改 `src/storage/postgres/schema-v1.ts`、migration 或 transaction command。
- 不修改 Job、Plan、PlanStep、StepRun 状态转换。
- 不修改 RuntimeEventWriter 的 record/commit/publish 顺序。
- 不修改 AgentLoop、StepRunner、ToolExecutor 协议。
- 不修改 Context v6 的 MessageGroup、TurnBundle、TokenBudget、manifest 和 checksum 规则。
- 不修改 HTTP 路由、SessionView、SSE event 和 Context Preview DTO。
- 工作区已有的文档重组及 Context Preview/API 修改不纳入本计划提交。

## Task 1: Move Job lifecycle ownership to orchestration

**Files:**

- Create: `src/orchestration/lifecycle/job-coordinator.ts`
- Delete: `src/runtime/job-coordinator.ts`
- Modify: `src/orchestration/agent-runtime.ts`
- Modify: `src/runtime/agent-runner.ts`
- Modify: `tests/job-coordinator.test.ts`
- Modify: `tests/postgres-agent-store.test.ts`
- Modify: `src/index.ts`

- [ ] Copy `JobCoordinator`, its option/result types and random IDs without changing implementation.
- [ ] Update every import to `orchestration/lifecycle/job-coordinator.js`.
- [ ] Keep `AgentRunner` depending on the coordinator type; do not move AgentRunner.
- [ ] Run:

```bash
npx vitest run tests/job-coordinator.test.ts
npm run typecheck
```

Expected: Job lifecycle tests pass with unchanged assertions.

- [ ] Commit only lifecycle move/import changes:

```bash
git commit -m "refactor: move job lifecycle into orchestration"
```

## Task 2: Move Direct and Planned workflows to orchestration

**Files:**

- Create: `src/orchestration/workflows/direct-job-workflow.ts`
- Create: `src/orchestration/workflows/planned-job-workflow.ts`
- Create: `src/orchestration/workflows/step-workflow.ts`
- Create: `src/orchestration/workflows/plan-finalizer.ts`
- Delete: `src/runtime/executors/direct-job-executor.ts`
- Delete: `src/runtime/executors/plan-executor.ts`
- Delete: `src/runtime/executors/step-executor.ts`
- Delete: `src/runtime/executors/plan-finalizer.ts`
- Modify: `src/index.ts`
- Test: `tests/postgres-agent-store.test.ts`

- [ ] Move existing behavior one class at a time and rename:

```text
DirectJobExecutor → DirectJobWorkflow
PlanExecutor      → PlannedJobWorkflow
StepExecutor      → StepWorkflow
PlanFinalizer     → PlanFinalizer
```

- [ ] Preserve method inputs/results and every waiting/retry/terminal branch.
- [ ] Update PostgreSQL E2E imports and run:

```bash
npx vitest run tests/postgres-agent-store.test.ts
npm run typecheck
```

Expected: production direct and two-step planned Job test remains green.

- [ ] Commit:

```bash
git commit -m "refactor: move job workflows into orchestration"
```

## Task 3: Extract execution Context policy from React runtime

**Files:**

- Create: `src/orchestration/execution/execution-context-provider.ts`
- Test: `tests/execution-context-provider.test.ts`

- [ ] Define the orchestration-facing interface:

```ts
export interface ExecutionContextProviderPort {
  buildPlanningContext(job: AgentJob, originalGoal: string): Promise<BuiltContext>;
  buildDirectContext(job: AgentJob, originalGoal: string): Promise<BuiltContext>;
  buildStepContext(input: {
    job: AgentJob;
    originalGoal: string;
    step: AgentPlanStep;
    stepRun: AgentStepRun;
  }): Promise<BuiltContext>;
}
```

- [ ] Implement `ExecutionContextProvider` with existing `ContextBuildService`, `DirectJobContextLoader`, `StepContextLoader`, `ContextCompressionService` and `SessionCompressionService`.
- [ ] Inject a narrow audited-model factory:

```ts
export interface ContextCompressionModelFactory {
  create(input: {
    job: AgentJob;
    context: BuiltContext;
    logicalCallKey: string;
    stepRunId?: string;
  }): Pick<AuditedChatModel, 'invoke'>;
}
```

- [ ] Preserve compression policy exactly:

```text
planning/direct + bundles → SessionCompressionService
step execution           → ContextCompressionService
preview/model inspection → does not use this provider and remains read-only
```

- [ ] Add tests asserting:

1. direct selects Session compression;
2. step selects StepRun compression;
3. a recommended compression reloads and recompiles material exactly once;
4. no compression returns the first compiled Context unchanged.

- [ ] Run:

```bash
npx vitest run tests/execution-context-provider.test.ts tests/context-loaders.test.ts
npm run typecheck
```

- [ ] Commit:

```bash
git commit -m "refactor: move context policy into orchestration"
```

## Task 4: Reduce ReactExecutor to an execution mechanism

**Files:**

- Create: `src/runtime/react-execution-runtime.ts`
- Delete: `src/runtime/executors/react-executor.ts`
- Modify: `src/runtime/agent-runner.ts` only if its import path changes
- Modify: `src/index.ts`
- Test: existing unit and PostgreSQL tests

- [ ] Rename the class and options:

```text
ReactExecutor        → ReactExecutionRuntime
ReactExecutorOptions → ReactExecutionRuntimeOptions
```

- [ ] Change inputs from context callbacks to compiled context:

```ts
runDirect(input: {
  job: AgentJob;
  context: BuiltContext;
}): Promise<DirectAgentRunResult>;

runStep(input: {
  job: AgentJob;
  stepRun: AgentStepRun;
  context: BuiltContext;
}): Promise<StepRunnerResult>;
```

- [ ] Delete from the runtime class:

- `ContextBuildService`;
- `ContextCompressionService`;
- `SessionCompressionService`;
- `buildContext()`;
- `purpose` and `loadContext()` branches.

- [ ] Keep unchanged:

- AgentLoop/AgentRunner/StepRunner creation;
- AuditedChatModel creation;
- bindTools;
- ToolExecutor;
- RuntimeEventWriter;
- execution limits and StepOutput repair.

- [ ] Run:

```bash
npm test
npm run typecheck
```

- [ ] Commit:

```bash
git commit -m "refactor: reduce react runtime to compiled context execution"
```

## Task 5: Move the real Job orchestrator out of Server

**Files:**

- Create: `src/orchestration/execution/job-execution-orchestrator.ts`
- Delete: `src/server/runtime/job-execution.service.ts`
- Modify: `src/server/main.ts`
- Modify: `src/server/runtime/default-planner.ts`
- Modify: `src/orchestration/agent-runtime.ts`
- Modify: `src/index.ts`
- Modify: `tests/postgres-agent-store.test.ts`

- [ ] Rename:

```text
RuntimeJobExecutionService → JobExecutionOrchestrator
RuntimeJobExecutionOptions → JobExecutionOrchestratorOptions
```

- [ ] Preserve the execution algorithm:

```text
deduplicate in-process execution
→ heartbeat
→ requireOwnedJob
→ resolve canonical goal
→ build planning context
→ route/create plan when required
→ DirectJobWorkflow or PlannedJobWorkflow
→ failIfOwned on non-lease error
→ stop heartbeat
```

- [ ] Replace internal Context/React ownership with:

- one `ReactExecutionRuntime`;
- one `ExecutionContextProvider`;
- `DirectJobWorkflow`;
- `PlannedJobWorkflow` with `StepWorkflow`.

- [ ] Keep default Planner provider construction in `server/runtime`; inject a factory/port into the orchestrator so orchestration never imports Server.
- [ ] Define the factory port in `job-execution-orchestrator.ts`:

```ts
export interface PlanEngineFactory {
  create(input: {
    job: AgentJob;
    routeModel: Runnable<BaseLanguageModelInput, AIMessageChunk>;
    createModel: Runnable<BaseLanguageModelInput, AIMessageChunk>;
    finalizeModel: Runnable<BaseLanguageModelInput, AIMessageChunk>;
  }): PlanEngine;
}
```

- [ ] Add `createDefaultPlanEngineFactory()` to `server/runtime/default-planner.ts`. It captures `store`, `workerId` and `publisher`, then constructs the existing `PlanEngine`, `DefaultPlanner`, `PlanSummarizer` and `DefaultPlanSummarizer` from the three injected audited models.
- [ ] Update `src/server/main.ts` to construct `JobExecutionOrchestrator` and pass it to `AgentRuntime` as `JobExecutionService`.
- [ ] Run:

```bash
npx vitest run tests/postgres-agent-store.test.ts
npm run typecheck
npm run build
```

- [ ] Commit:

```bash
git commit -m "refactor: make job execution an orchestration service"
```

## Task 6: Enforce dependency boundaries and full regression

**Files:**

- Modify only imports/tests/docs required by the preceding moves
- Do not modify dirty user-owned Context Preview/API files unless compilation proves an import-only change is necessary

- [ ] Confirm no old implementation paths remain:

```bash
rg -n "server/runtime/job-execution|runtime/executors|runtime/job-coordinator|RuntimeJobExecutionService|ReactExecutor" src tests
```

Expected: no matches except migration documentation.

- [ ] Confirm Server dependency direction:

```bash
rg -n "from '../../server|from '../server" src/orchestration src/runtime
```

Expected: no matches.

- [ ] Run the complete regression suite:

```bash
npm test
npm run test:postgres
npm run typecheck
npm run build
```

Expected: every command exits 0.

- [ ] Verify frozen persistence/event implementation:

```bash
git diff 8b1a9f4 -- \
  src/storage/postgres/schema-v1.ts \
  src/storage/postgres/transaction-commands.ts \
  src/runtime/runtime-event-writer.ts
```

Expected: empty diff, except a pure path move if RuntimeEventWriter was moved (this plan does not require moving it).

- [ ] Verify direct, planned, Step retry, HITL resume, cancellation, Context Preview and ModelCall reconstruction tests remain green.
- [ ] Commit final import/test cleanup without staging unrelated working-tree changes:

```bash
git commit -m "test: verify orchestration runtime boundary"
```

## Definition of done

- `src/orchestration` contains the complete Job route/direct/planned/Step/finalize lifecycle.
- `src/runtime` contains ReAct, model, tool, event and Context execution mechanisms, without direct/planned/next-step strategy decisions.
- `src/server/runtime` contains providers/config/composition only.
- `ReactExecutionRuntime` accepts `BuiltContext` and has no context-loading or compression-policy branches.
- Context v6 messages/manifests/checksums remain unchanged for equivalent persisted facts.
- Database schema, transaction commands, Job/Plan/Step state flow, SSE and HTTP contracts remain unchanged.
- All tests, PostgreSQL integration, typecheck and build pass.
