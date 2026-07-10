# Canonical Job and StepRun Domain Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有 AgentTask 运行路径的前提下，建立完整 Job + StepRun canonical domain contracts，供新 Schema V1、事务命令和后续编排切换使用。

**Architecture:** 新契约暂放在 `src/domain/canonical/`，避免与仍在生产路径中的 legacy `AgentPlan`、`AgentMessage` 类型同名冲突。所有 canonical 类型内部使用最终命名；新存储与运行时只允许依赖 canonical barrel，最终切换阶段删除 legacy 后再把目录内容提升到 `src/domain/`。

**Tech Stack:** TypeScript strict mode、Vitest。

---

### Task 1: Define Job, Plan, PlanStep, and StepRun contracts

**Files:**

- Create: `src/domain/canonical/job.ts`
- Create: `src/domain/canonical/plan.ts`
- Create: `src/domain/canonical/step-run.ts`
- Test: `tests/canonical-domain.test.ts`

- [ ] **Step 1: Write failing status and transition tests**

Create `tests/canonical-domain.test.ts` with assertions for terminal Job status, allowed resume transitions, failed Job immutability, and active StepRun statuses.

```ts
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_JOB_STATUSES,
  ACTIVE_STEP_RUN_STATUSES,
  canTransitionJob,
  isTerminalJobStatus,
} from '../src/domain/canonical/index.js';

describe('canonical runtime domain', () => {
  it('treats failed jobs as terminal and requires a new retry job', () => {
    expect(isTerminalJobStatus('failed')).toBe(true);
    expect(canTransitionJob('failed', 'resuming')).toBe(false);
  });

  it('allows waiting jobs to be claimed for resume', () => {
    expect(canTransitionJob('waiting_user_input', 'resuming')).toBe(true);
    expect(canTransitionJob('resuming', 'running')).toBe(true);
  });

  it('defines database-active statuses consistently', () => {
    expect(ACTIVE_JOB_STATUSES).toEqual([
      'created',
      'running',
      'waiting_user_input',
      'resuming',
    ]);
    expect(ACTIVE_STEP_RUN_STATUSES).toEqual([
      'created',
      'running',
      'waiting_user_input',
      'resuming',
    ]);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

```bash
npm test -- --run tests/canonical-domain.test.ts
```

Expected: FAIL because `src/domain/canonical/index.ts` does not exist.

- [ ] **Step 3: Implement Job and transition contracts**

`job.ts` must define final status/strategy/stage names, `AgentJob`, `AgentJobError`, the active/terminal constants, and an explicit transition map. `failed`, `completed`, and `cancelled` have no outgoing transitions.

- [ ] **Step 4: Implement declarative Plan/PlanStep contracts**

`plan.ts` must define `AgentPlan`, `AgentPlanStep`, version fields, ordered position, status unions, and `outputMessageId`; it must not contain legacy `rootTaskId` or `taskId` fields.

- [ ] **Step 5: Implement StepRun contracts**

`step-run.ts` must define `runNo`, `currentAttemptId`, `attemptNo`, final output/error fields, and no lease fields. Export the active StepRun status constant used by the database partial indexes.

- [ ] **Step 6: Run domain tests and typecheck**

```bash
npm test -- --run tests/canonical-domain.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit workflow contracts**

```bash
git add src/domain/canonical tests/canonical-domain.test.ts
git commit -m "feat: define canonical job and step run domain"
```

### Task 2: Define message, tool invocation, and user-input contracts

**Files:**

- Create: `src/domain/canonical/message.ts`
- Create: `src/domain/canonical/tool-invocation.ts`
- Create: `src/domain/canonical/user-input-request.ts`
- Modify: `tests/canonical-domain.test.ts`

- [ ] **Step 1: Add failing protocol invariant tests**

Add tests proving that tool-origin input only supports `as_tool_result`, ToolInvocation has per-call status, and private reasoning is not a message channel.

- [ ] **Step 2: Implement canonical message dictionary**

Define the controlled `message_type` union from design 06, `normal | progress | final` channels, UI/internal visibility, batch tool-call payload, and one-result-per-tool-message payload.

- [ ] **Step 3: Implement ToolInvocation contract**

Define `read_only | idempotent | side_effecting`, the seven invocation statuses, stable idempotency key, argument checksum, result/error fields, and entity version.

- [ ] **Step 4: Implement UserInputRequest contract and schema union**

Define source, answer mode, status, text/single/multi/approval schemas, answer message linkage, client answer id, and version.

- [ ] **Step 5: Run tests and typecheck**

```bash
npm test -- --run tests/canonical-domain.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit protocol contracts**

```bash
git add src/domain/canonical tests/canonical-domain.test.ts
git commit -m "feat: define canonical message and tool contracts"
```

### Task 3: Define context, model-call, usage, and realtime contracts

**Files:**

- Create: `src/domain/canonical/context-summary.ts`
- Create: `src/domain/canonical/model-call.ts`
- Create: `src/domain/canonical/realtime-event.ts`
- Create: `src/domain/canonical/session.ts`
- Create: `src/domain/canonical/code-project.ts`
- Create: `src/domain/canonical/index.ts`
- Modify: `tests/canonical-domain.test.ts`

- [ ] **Step 1: Add failing dictionary consistency tests**

Assert final owner types, context purposes, model call types, model call statuses, and realtime entity event names.

- [ ] **Step 2: Implement ContextSummary contracts**

Use `ownerType/ownerId`, final purpose names, context rules version, summary chain IDs, row range, checksum, token counts, and entity version.

- [ ] **Step 3: Implement ModelCall and ModelUsageStats contracts**

Use stable `logicalCallKey`, separate `callAttemptNo`, input manifest, provider usage source, result/error payload, and aggregate cache fields.

- [ ] **Step 4: Implement RealtimeEvent union**

Include only `message.delta` as ephemeral plus canonical entity `*.upserted` and `model_usage.updated`; every mutable entity payload already carries version.

- [ ] **Step 5: Implement Session/CodeProject contracts and canonical barrel**

Export only canonical modules from `src/domain/canonical/index.ts`. Do not add them to legacy `src/domain/index.ts` yet, preventing accidental partial cutover.

- [ ] **Step 6: Run all domain and backend checks**

```bash
npm test -- --run tests/canonical-domain.test.ts
npm run typecheck
npm run build
npm test
```

Expected: canonical tests and all 92 legacy non-PostgreSQL tests PASS.

- [ ] **Step 7: Commit the remaining contracts**

```bash
git add src/domain/canonical tests/canonical-domain.test.ts
git commit -m "feat: complete canonical runtime domain contracts"
```
