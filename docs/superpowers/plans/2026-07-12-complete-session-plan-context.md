# Complete Session + Plan Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改数据库 schema、Runtime 落库事务、Plan/Step/ReAct 执行链路和 SSE 协议的前提下，实现完整 Session/Plan 事实加载、TurnBundle 原子上下文选择、可控工具结果投影、Session 滚动摘要，以及可精确重建的 v6 Context Preview。

**Architecture:** 保持 PostgreSQL 为完整事实源，将只读上下文路径拆成 `Facts Loader → MessageGroup Projector → TurnBundle Builder → Context Compiler`。Loader 只读并校验关系；Projector 构造 Plan/Step/Tool 语义组；Budget 只选择连续完整 TurnBundle；Compiler 输出 LangChain Messages 和 InputManifest。正式执行与调试预览共用纯编译路径，只有正式执行允许在编译前触发 Session 压缩写入。

**Tech Stack:** TypeScript、Node.js、LangChain Core Messages、PostgreSQL、Vitest、Zod、现有 AgentStore/ContextSummary/ModelCall 基础设施。

---

## Frozen compatibility contract

- 不修改 `src/storage/postgres/schema-v1.ts`、migration、任何数据库表或索引。
- 不修改 createPlan → createStepRun → ReAct → commitStepOutput → finalize 的落库事务顺序。
- 不修改 `RuntimeEventWriter`、SSE 事件类型或事件提交顺序。
- 不将 `plan_final.plan_id IS NULL` 作为写入修复；读取投影通过 `message.jobId → job → unique plan` 兼容现存数据。
- Context v5 的历史 ModelCall 必须继续按 v5 manifest 精确重建；新调用写入 v6 manifest。
- 原始 ToolResult 永久保存在数据库和 View 中；仅模型输入投影允许确定性裁剪。

## Task 1: Add v6 context domain types and semantic message groups

**Files:**

- Modify: `src/domain/model-call.ts`
- Modify: `src/runtime/context/context-material.ts`
- Modify: `src/runtime/context/message-group-builder.ts`
- Modify: `src/runtime/context/context-formatter.ts`
- Test: `tests/context-builder.test.ts`

- [ ] **Step 1: Add failing tests for semantic groups**

Add fixtures containing one direct turn and one planned turn. Assert:

```ts
expect(groups.map((group) => group.type)).toEqual([
  'single',
  'plan_definition',
  'tool_exchange',
  'step_output',
  'plan_final',
]);
expect(planDefinition.steps.map((step) => step.position)).toEqual([0, 1]);
expect(planFinal.plan.id).toBe(plan.id);
```

Also cover a legacy `plan_final` message whose `planId` is absent and must resolve from its `jobId`.

- [ ] **Step 2: Run focused test and confirm failure**

Run:

```bash
npx vitest run tests/context-builder.test.ts
```

Expected: compile/test failure because semantic group variants and v6 manifest fields do not exist.

- [ ] **Step 3: Extend the model-call manifest compatibly**

Add optional v6 audit fields so v5 rows remain decodable:

```ts
selectedBundleIds?: string[];
summarizedBundleIds?: string[];
truncatedToolResultMessageIds?: string[];
```

Keep `messageGroupIds`, `summaryIds`, row bounds and checksums unchanged.

- [ ] **Step 4: Define semantic context types**

In `context-material.ts`, add `RuntimeRefs`, `PlanDefinitionGroup`, `StepOutputGroup`, and `PlanFinalGroup`. Preserve `single` and `tool_exchange`. Add annotations used by preview/audit without changing persisted messages:

```ts
interface CompiledContextAnnotation {
  sourceMessageId?: string;
  groupId: string;
  bundleId?: string;
  projected?: boolean;
  truncated?: boolean;
  originalTokenEstimate?: number;
  projectedTokenEstimate?: number;
  checksum?: string;
}
```

- [ ] **Step 5: Project immutable PlanDefinition and structured StepOutput**

Update `MessageGroupBuilder` to accept indexed Session facts. It must:

- anchor PlanDefinition at the persisted `plan_created.rowId`;
- sort PlanStep by `position`;
- exclude mutable step status, run number and retry state from model-visible PlanDefinition;
- parse StepOutput only with existing `parseStepOutput()` from structured metadata;
- resolve PlanFinal by explicit planId first, then unique plan for `jobId`;
- keep incomplete ToolExchange groups blocked from normal next-turn context.

- [ ] **Step 6: Format semantic groups as LangChain messages**

`ContextFormatter` must emit:

- immutable PlanDefinition as an `AIMessage` for historical planned turns;
- StepOutput as a stable structured `AIMessage` containing step identity and validated output;
- PlanFinal as the persisted final `AIMessage`;
- ToolExchange as one `AIMessage(tool_calls)` followed by every matching `ToolMessage`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npx vitest run tests/context-builder.test.ts
npm run typecheck
```

Expected: semantic group tests pass and no manifest consumers break.

- [ ] **Step 8: Commit**

```bash
git add src/domain/model-call.ts src/runtime/context tests/context-builder.test.ts
git commit -m "refactor: add semantic context groups"
```

## Task 2: Build complete TurnBundle units, including retry lineage

**Files:**

- Create: `src/runtime/context/turn-bundle-builder.ts`
- Modify: `src/runtime/context/context-material.ts`
- Create: `tests/turn-bundle-builder.test.ts`

- [ ] **Step 1: Add failing TurnBundle tests**

Cover:

1. direct HumanMessage + final AIMessage becomes one `direct_turn`;
2. plan_created + all tool exchanges + validated StepOutputs + plan_final becomes one `planned_turn`;
3. retry jobs sharing `retryOfJobId` belong to the same root turn and contain the canonical goal exactly once;
4. unfinished jobs are marked `terminal: false` and are not candidates for Session rolling summary;
5. source row ranges are monotonic and groups retain database order.

- [ ] **Step 2: Run test and confirm failure**

```bash
npx vitest run tests/turn-bundle-builder.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement deterministic bundle construction**

Expose:

```ts
class TurnBundleBuilder {
  build(input: {
    sessionId: string;
    jobs: AgentJob[];
    groups: MessageGroup[];
  }): { bundles: TurnBundle[]; blocked: BlockedMessageGroup[] };
}
```

Rules:

- derive `rootJobId` by following `retryOfJobId` with cycle detection;
- order bundles by first persisted message `rowId`, never by UI timestamps alone;
- classify bundle as planned if its lineage owns a PlanDefinition;
- include every group belonging to the lineage, including failed attempts;
- select the canonical HumanMessage using persisted goal message identity, never content deduplication;
- set `terminal` only when the latest lineage Job and protocol groups are terminal.

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run tests/turn-bundle-builder.test.ts
npm run typecheck
git add src/runtime/context/turn-bundle-builder.ts src/runtime/context/context-material.ts tests/turn-bundle-builder.test.ts
git commit -m "refactor: group context into atomic turn bundles"
```

## Task 3: Add deterministic model-side ToolResult projection

**Files:**

- Create: `src/runtime/context/tool-result-context-projector.ts`
- Modify: `src/runtime/context/context-formatter.ts`
- Modify: `src/runtime/context/context-compiler.ts`
- Create: `tests/tool-result-context-projector.test.ts`

- [ ] **Step 1: Add failing projection tests**

Assert that:

- short ToolResult content remains byte-for-byte unchanged;
- content over 8,000 estimated tokens keeps about 60% head and 40% tail;
- the marker contains original/projected token estimates and SHA-256 checksum;
- ToolMessage identity and `tool_call_id` never change;
- repeated projection returns identical output;
- manifest records exactly the truncated ToolResult message IDs.

- [ ] **Step 2: Implement the pure projector**

```ts
interface ToolResultProjection {
  content: string;
  truncated: boolean;
  originalTokenEstimate: number;
  projectedTokenEstimate: number;
  checksum: string;
}
```

Use the existing token estimator. Default cap is 8,000 tokens, head ratio is 0.6, and tail ratio is 0.4. Serialize non-string ToolResult content deterministically before hashing/truncating. Do not mutate `AgentMessage` or database values.

- [ ] **Step 3: Apply projection before final budget measurement**

`ContextFormatter` projects only ToolMessage content. `ContextCompiler` estimates the actual formatted LangChain messages after projection and adds annotations/manifest audit fields.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/tool-result-context-projector.test.ts tests/context-builder.test.ts
npm run typecheck
git add src/runtime/context/tool-result-context-projector.ts src/runtime/context/context-formatter.ts src/runtime/context/context-compiler.ts tests
git commit -m "feat: cap model-visible tool results"
```

## Task 4: Make TokenBudget select complete recent TurnBundles

**Files:**

- Modify: `src/runtime/context/token-budget.ts`
- Modify: `src/runtime/context/context-compiler.ts`
- Modify: `src/runtime/context/context-material.ts`
- Test: `tests/context-builder.test.ts`

- [ ] **Step 1: Add failing atomic-selection tests**

Create three bundles where the middle planned bundle alone exceeds the remaining budget. Assert:

```ts
expect(result.selectedBundleIds).toEqual(['turn:newest']);
expect(result.selectedGroupIds).toEqual(newest.groups.map((group) => group.id));
expect(result.selectedGroupIds).not.toContain('step_output:middle-step');
```

Also assert current must-keep bundle is either fully selected or compilation raises a typed context-overflow error; it must never be partially selected.

- [ ] **Step 2: Replace sparse group selection with tail bundle selection**

Budget order:

1. fixed messages and tool schemas;
2. active Session summary;
3. required current bundle/current execution material;
4. completed historical bundles from newest to oldest;
5. restore selected bundles and their groups to ascending persisted order.

Do not skip an older bundle and then select an even older one; selected history must be a contiguous tail.

- [ ] **Step 3: Preserve a v5 group-selection branch**

Keep the existing group selector callable for v5 ModelCall reconstruction. New v6 material uses `bundles`; old manifests use the legacy branch.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/context-builder.test.ts
npm run typecheck
git add src/runtime/context/token-budget.ts src/runtime/context/context-compiler.ts src/runtime/context/context-material.ts tests/context-builder.test.ts
git commit -m "refactor: budget context by complete turns"
```

## Task 5: Load complete Session facts and reuse them for direct and step execution

**Files:**

- Modify: `src/runtime/loaders/session-context-loader.ts`
- Modify: `src/runtime/loaders/direct-job-context-loader.ts`
- Modify: `src/runtime/loaders/step-context-loader.ts`
- Modify: `src/runtime/loaders/plan-context-loader.ts`
- Modify: `tests/context-loaders.test.ts`
- Modify: `tests/context-inspection.service.test.ts`

- [ ] **Step 1: Add failing loader tests**

Extend the in-memory store fixture with jobs, plans, plan steps and StepRuns. Assert Session facts contain all entities and that a next-turn history with both direct and planned work compiles in this order:

```text
System runtime policy
System runtime environment
Session rolling summary (optional)
Human direct goal
AI direct final
Human planned goal
AI immutable PlanDefinition
AI/Tool step protocol exchanges
AI validated StepOutputs
AI plan final
current Human goal (formal direct execution only)
```

- [ ] **Step 2: Expand SessionContextLoader as a read-only fact loader**

Read and index:

```text
listSessionJobs
listSessionMessages
listSessionToolInvocations
listSessionPlans
listSessionPlanSteps
listJobStepRuns for every Session Job
listActiveContextSummaries(session, conversation, v6)
```

Use bounded parallel reads for StepRuns. Validate dangling plan/step/run references and return them as blocked diagnostics rather than silently inventing context.

- [ ] **Step 3: Reuse Session facts in DirectJobContextLoader**

Formal direct execution must equal next-turn compiled history plus the already-persisted current goal. Retry lineage must not duplicate the canonical goal.

- [ ] **Step 4: Make Step context complete and execution-local**

`StepContextLoader` must supply:

- fixed Step runtime policy/environment;
- immutable current PlanDefinition as SystemMessage;
- Session baseline summary and recent complete historical bundles;
- current planned goal;
- every complete current-plan StepExecution bundle before the active step;
- current Step instruction as the final SystemMessage.

It must not include the current Plan's historical `plan_created` AIMessage a second time.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run tests/context-loaders.test.ts tests/context-inspection.service.test.ts
npm run typecheck
git add src/runtime/loaders tests/context-loaders.test.ts tests/context-inspection.service.test.ts
git commit -m "refactor: load complete session and plan context facts"
```

## Task 6: Add structured Session rolling-summary compaction

**Files:**

- Create: `src/runtime/context/session-compression.service.ts`
- Modify: `src/runtime/context/context-build.service.ts`
- Modify: `src/runtime/context/context-compression.service.ts`
- Modify runtime dependency wiring where `ContextBuildService` is constructed
- Create: `tests/session-compression.service.test.ts`
- Modify: `tests/postgres-agent-store.test.ts`

- [ ] **Step 1: Add failing summary-boundary tests**

Assert that compaction:

- only consumes a complete contiguous prefix of terminal TurnBundles;
- never includes fixed runtime/tool schemas or the active/incomplete turn;
- writes `ownerType=session`, `purpose=conversation`, `summaryType=rolling`, JSON format;
- retains root job IDs, bundle IDs and source row range;
- replaces the prior active Session summary using existing store APIs;
- leaves all source messages untouched.

- [ ] **Step 2: Define `SessionRollingSummaryV1`**

```ts
interface SessionRollingSummaryV1 {
  schemaVersion: 1;
  sourceBundleIds: string[];
  sourceJobIds: string[];
  sourceRowIdStart: number;
  sourceRowIdEnd: number;
  userGoals: string[];
  decisions: string[];
  planOutcomes: Array<{ planId: string; title: string; summary: string }>;
  artifacts: Array<{ path?: string; title?: string; kind?: string }>;
  unresolved: string[];
}
```

- [ ] **Step 3: Implement explicit compaction decision**

Trigger only when token pressure or configured message threshold requires it. The service computes the oldest removable prefix, generates/validates the structured summary, and persists through existing `replaceContextSummary`. Context Preview and ModelCall inspection call pure compilation only and never trigger writes.

- [ ] **Step 4: Integrate with formal build path**

`ContextBuildService` may invoke Session compression before reloading material for formal next-turn/direct execution. Step and Plan executors keep their own closed-loop contexts and do not ask orchestration to synthesize execution internals.

- [ ] **Step 5: Verify PostgreSQL behavior and commit**

```bash
npx vitest run tests/session-compression.service.test.ts
npm run test:postgres -- --run tests/postgres-agent-store.test.ts
npm run typecheck
git add src/runtime/context tests/session-compression.service.test.ts tests/postgres-agent-store.test.ts
git commit -m "feat: compact old session turns into rolling summaries"
```

## Task 7: Share v6 pure compilation with ContextInspection and Preview

**Files:**

- Modify: `src/orchestration/context-inspection.service.ts`
- Modify: `src/runtime/loaders/model-call-context-loader.ts`
- Modify: `src/server/debug/context-preview-contract.ts`
- Modify: `src/server/debug/context-preview.service.ts`
- Modify: `tests/context-inspection.service.test.ts`
- Modify: `tests/context-preview.service.test.ts`

- [ ] **Step 1: Add failing preview tests**

For `next_turn`, assert no unsent draft and no persistence writes. For planned history, assert preview returns semantic PlanDefinition, every selected StepOutput, PlanFinal, bundle selection and ToolResult truncation annotations.

- [ ] **Step 2: Extend preview DTO without exposing bulky internals**

Return a compact JSON representation:

```ts
interface ContextPreviewMessage {
  index: number;
  langChainType: string;
  content: unknown;
  toolCalls?: unknown[];
  toolCallId?: string;
  source?: CompiledContextAnnotation;
}
```

Include manifest, selected/summarized bundle IDs, truncated ToolResult IDs, token breakdown and blocked diagnostics.

- [ ] **Step 3: Use the same loaders/projector/compiler**

`ContextInspectionService` dispatch remains:

```text
next_turn  → SessionContextLoader
job        → DirectJobContextLoader
step_run   → StepContextLoader
model_call → ModelCallContextLoader
```

The inspection layer selects a provider; it does not teach `ContextCompiler` about Runtime entities. Preview remains read-only.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/context-inspection.service.test.ts tests/context-preview.service.test.ts
npm run typecheck
git add src/orchestration/context-inspection.service.ts src/runtime/loaders/model-call-context-loader.ts src/server/debug tests
git commit -m "feat: expose v6 context selection in debug preview"
```

## Task 8: Version v6 and preserve exact v5 ModelCall reconstruction

**Files:**

- Modify version constant owner found by `rg "CONTEXT_RULES_VERSION" src`
- Modify: `src/runtime/loaders/model-call-context-loader.ts`
- Modify: `src/runtime/context/context-compiler.ts`
- Test: `tests/context-inspection.service.test.ts`
- Test: `tests/context-builder.test.ts`

- [ ] **Step 1: Add v5/v6 reconstruction fixtures**

Persist one v5 manifest with legacy `messageGroupIds` and one v6 manifest with bundle fields. Assert inspection selects the recorded compiler branch and reproduces identical message order/checksum for each fixture.

- [ ] **Step 2: Bump only new formal calls to v6**

Set the current rule version to `context-v6`. Do not rewrite historical ModelCall rows or summaries.

- [ ] **Step 3: Implement version dispatch and typed unsupported-version error**

Known v5 uses the legacy group projection. Known v6 uses semantic bundles. Unknown versions fail explicitly instead of silently compiling with latest rules.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/context-builder.test.ts tests/context-inspection.service.test.ts
npm run typecheck
git add src tests
git commit -m "feat: version complete context projection as v6"
```

## Task 9: End-to-end regression and real-session verification

**Files:**

- Modify only files needed for defects found by verification
- Update: `docs/superpowers/specs/2026-07-12-complete-session-plan-context-design.md` if implementation exposes a real contract correction

- [ ] **Step 1: Run the complete automated suite**

```bash
npm test
npm run test:postgres
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 2: Verify no forbidden persistence changes**

```bash
git diff 622d5b2 -- src/storage/postgres/schema-v1.ts src/storage/postgres/migrations.ts src/storage/postgres/transaction-commands.ts src/runtime/runtime-event-writer.ts
```

Expected: empty diff for schema, migrations, transaction writes and SSE writer.

- [ ] **Step 3: Verify the known real planned Session**

Use the debug context endpoint for:

```text
session_f1350f46-23a6-41f2-9b34-d5cad32fd461
```

Assert:

- direct and planned history appears in database row order;
- the 8-step immutable PlanDefinition is present;
- StepOutputs for positions 0–7 are associated with the correct StepRun;
- ToolCall/ToolResult pairs stay adjacent;
- `plan_final.plan_id IS NULL` is resolved through its Job's unique Plan;
- the final Plan answer appears once;
- selected bundles form a contiguous recent tail.

- [ ] **Step 4: Restart and smoke-test the server**

Build, restart the local server using the existing dotenv configuration, request the Session view and Context Preview, and confirm HTTP 200 plus stable JSON shape.

- [ ] **Step 5: Final self-review and commit**

Review every design section against implementation, search for placeholders (`TODO`, `FIXME`, temporary branches), and confirm all new types have consumers.

```bash
rg -n "TODO|FIXME|context-v5|context-v6|selectedBundleIds|summarizedBundleIds|truncatedToolResultMessageIds" src tests
git status --short
git add src tests docs
git commit -m "refactor: complete session and plan context pipeline"
```

## Definition of done

- A normal next turn can answer follow-up questions using prior direct answers and complete prior Plan/Step outcomes.
- A StepRun receives the complete current Plan and every prior validated StepOutput needed for execution.
- A planned turn is never partially selected by TokenBudget.
- Tool protocol pairs are never broken; large results are deterministically projected only for model input.
- Old completed TurnBundles may be represented by one structured Session rolling summary while raw rows remain queryable.
- Context Preview and formal execution share the same pure loaders/projector/compiler path, but preview performs no writes and includes no draft.
- v5 and v6 ModelCalls are reconstructed with their recorded rules.
- Database schema, persistence transaction chain and SSE event behavior remain unchanged.
