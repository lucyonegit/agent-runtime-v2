# 独立 Planner + ReAct 唯一编排实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复独立 `PlannerCore + PlannerReactAgent`，让普通 Agent 统一经过路由后执行 direct ReAct 或 Planner step ReAct，并彻底删除 planner-as-tool 路径。

**Architecture:** `PlannerReactAgent` 是普通 Agent 唯一编排入口；`PlannerCore` 负责 route/create/final 三类模型调用，`ReactCore` 保持通用工具循环。普通 ReAct 使用 general tools，Planner step 使用 general tools 加内部 `submit_step_result`，数据库 timeline 仍保存完整 task/message/tool 审计数据。

**Tech Stack:** TypeScript、LangChain `BaseMessage`、NestJS、PostgreSQL、Vitest、现有 `ReactCore`、`AgentSessionStore`、`ContextBuilder`。

---

## 文件结构

### 新建

- `src/core/planner/planner-core.ts`：Planner 模型协议、route/create/final 调用与结构校验。
- `src/core/planner/index.ts`：Planner core 导出。
- `src/orchestration/planner-context-projection.ts`：四类目的化 LangChain message projection。
- `src/orchestration/planner-react-agent.ts`：唯一普通 Agent 编排器与恢复状态机。
- `tests/planner-core.test.ts`：Planner 结构解析测试。
- `tests/planner-context-projection.test.ts`：上下文隔离测试。
- `tests/planner-react-agent.test.ts`：direct/plan/HITL/恢复测试。

### 修改

- `src/core/index.ts`：导出 Planner core。
- `src/orchestration/index.ts`：导出 Planner 编排器与 projection。
- `src/orchestration/system-prompts.ts`：删除 planner-as-tool 指令。
- `src/orchestration/react-agent.ts`：删除 planner tool result 的专有处理。
- `src/tools/index.ts`：拆分 general tools 与 planner-step tools。
- `src/view/session-view.ts`：删除 planner tool 过滤兼容逻辑，保留 task/step 聚合。
- `src/server/runtime/qwen-runtime.ts`：构造 planner、direct React、planner-step React、code 四个运行单元。
- `src/server/http/tokens.ts`：恢复 Planner 与 step React DI token。
- `src/server/http/server.module.ts`：注册 Planner 与 step React。
- `src/server/http/agent-runtime.service.ts`：所有普通入口使用 `PlannerReactAgent`。
- `src/server/main.ts`：注入完整 runtime。
- `tests/runtime-tools.test.ts`、`tests/api.test.ts`、`tests/session-view.test.ts`、`tests/orchestrator.test.ts`：删除旧路径断言并覆盖唯一入口。
- `docs/runtime-architecture-overview-zh.md`、`docs/nestjs-api.md`：同步最终架构。

### 删除

- `src/tools/planner-tools.ts`
- 对应 `dist/tools/planner-tools.*`（重新 build 后确认不存在）

---

### Task 1: 恢复 PlannerCore 的强类型协议

**Files:**

- Create: `src/core/planner/planner-core.ts`
- Create: `src/core/planner/index.ts`
- Modify: `src/core/index.ts`
- Test: `tests/planner-core.test.ts`

- [ ] **Step 1: 写失败测试，锁定 route/create/final 协议**

```ts
import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { PlannerCore } from '../src/core/index.js';

describe('PlannerCore', () => {
  it('routes a goal without supportsRouting fallback branches', async () => {
    const planner = new PlannerCore({
      model: { invoke: async () => new AIMessage('{"mode":"direct_answer","reason":"simple"}') },
    });
    await expect(planner.routeGoal({ messages: [] })).resolves.toMatchObject({
      route: { mode: 'direct_answer', reason: 'simple' },
    });
  });

  it('rejects duplicate or empty plan steps', async () => {
    const planner = new PlannerCore({
      model: { invoke: async () => new AIMessage('{"id":"plan_1","title":"x","steps":[{"id":"step_1","title":"A","instruction":"a"},{"id":"step_1","title":"B","instruction":"b"}]}') },
    });
    await expect(planner.createPlan({ messages: [] })).rejects.toThrow('duplicate step id');
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run tests/planner-core.test.ts`

Expected: FAIL，提示 `PlannerCore` 不存在。

- [ ] **Step 3: 实现最小 PlannerCore**

```ts
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { AgentModelTokenUsage } from '../../domain/index.js';

export type PlannerRoute = { mode: 'direct_answer' | 'plan'; reason: string };
export type PlannerStep = { id: string; title: string; instruction: string };
export type PlannerPlan = { id: string; title: string; steps: PlannerStep[] };

export interface PlannerModel {
  invoke(messages: BaseMessage[]): Promise<AIMessage>;
}

export class PlannerCore {
  constructor(private readonly config: { model: PlannerModel }) {}

  async routeGoal(input: { messages: BaseMessage[] }) {
    const response = await this.config.model.invoke(input.messages);
    return { route: parseRoute(readText(response)), usage: readUsage(response) };
  }

  async createPlan(input: { messages: BaseMessage[] }) {
    const response = await this.config.model.invoke(input.messages);
    return { plan: parsePlan(readText(response)), usage: readUsage(response) };
  }

  async completePlan(input: { messages: BaseMessage[] }) {
    const response = await this.config.model.invoke(input.messages);
    const content = readText(response).trim();
    if (!content) throw new Error('Planner final output is empty');
    return { content, usage: readUsage(response) };
  }
}
```

实现 `parseRoute/parsePlan/readText/readUsage`，要求：只解析 JSON object、route 枚举严格校验、plan 需要 1-5 个非空且 id 唯一的 steps，拒绝静默 fallback；不要恢复 `supportsRouting`。

- [ ] **Step 4: 导出并运行测试**

```ts
// src/core/planner/index.ts
export * from './planner-core.js';

// src/core/index.ts
export * from './react/index.js';
export * from './planner/index.js';
```

Run: `npx vitest run tests/planner-core.test.ts && npm run typecheck`

Expected: PASS，TypeScript exit code 0。

---

### Task 2: 恢复 Planner Context Projection

**Files:**

- Create: `src/orchestration/planner-context-projection.ts`
- Test: `tests/planner-context-projection.test.ts`

- [ ] **Step 1: 写四类 projection 的失败测试**

测试固定包含两个 step 的 timeline，并断言：

```ts
expect(buildPlanStepMessages(input).map(message => message.content)).toEqual([
  REACT_SYSTEM_PROMPT,
  expect.stringContaining('现在只执行当前步骤：step_2'),
  'step_2 current assistant tool call',
  'step_2 current tool result',
]);
expect(serialized).not.toContain('step_1 raw search');
expect(serialized).toContain('step_1 stable result');
```

同时覆盖：

- route/create 不包含任何 step internal messages。
- step 只包含 previous `step_result` 和 current task runtime tail。
- final 只包含 goal、plan、按顺序排列的 step results。
- tool call/result 在 current step tail 中保持顺序和配对。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run tests/planner-context-projection.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 projection API**

```ts
export interface PlannerRuntimeNow {
  currentDate: string;
  timeZone: string;
}

export function buildPlannerRouteMessages(input: {
  routerSystemPrompt: string;
  goal: string;
  now: PlannerRuntimeNow;
  visibleSummary?: string;
}): BaseMessage[];

export function buildPlanCreateMessages(input: {
  plannerSystemPrompt: string;
  goal: string;
  now: PlannerRuntimeNow;
  visibleSummary?: string;
}): BaseMessage[];

export function buildPlanStepMessages(input: {
  reactSystemPrompt: string;
  goal: string;
  now: PlannerRuntimeNow;
  plan: PlannerPlan;
  currentStep: PlannerStep;
  previousStepResults: AgentMessage[];
  currentRuntimeTail: AgentMessage[];
  contextBuilder: ContextBuilder;
}): BaseMessage[];

export function buildPlanFinalMessages(input: {
  finalSystemPrompt: string;
  goal: string;
  now: PlannerRuntimeNow;
  plan: PlannerPlan;
  stepResults: AgentMessage[];
}): BaseMessage[];
```

`currentRuntimeTail` 只允许当前 step task 的 `message/tool_call/tool_result`；调用现有 `ContextBuilder` 的单条消息转换能力保证 LangChain `AIMessage/ToolMessage` 协议正确，不调用 session 全量 `buildForModel()`。

- [ ] **Step 4: 运行 projection 测试**

Run: `npx vitest run tests/planner-context-projection.test.ts`

Expected: 4 类 projection 全部 PASS。

---

### Task 3: 隔离普通工具与 Planner Step 工具

**Files:**

- Modify: `src/tools/index.ts`
- Delete: `src/tools/planner-tools.ts`
- Modify: `tests/runtime-tools.test.ts`

- [ ] **Step 1: 先修改测试表达最终工具集合**

```ts
expect(createRuntimeTools().map(tool => tool.name)).not.toEqual(expect.arrayContaining([
  'create_plan',
  'update_plan',
  'set_plan_step_status',
  'submit_step_result',
]));

expect(createPlannerStepRuntimeTools().map(tool => tool.name)).toEqual(expect.arrayContaining([
  'request_user_input',
  'submit_step_result',
  'browse_url',
  'web_search',
]));
```

- [ ] **Step 2: 运行测试确认旧实现失败**

Run: `npx vitest run tests/runtime-tools.test.ts`

Expected: FAIL，因为 general tools 仍含 planner tools。

- [ ] **Step 3: 修改工具工厂并删除 planner-tools**

```ts
export function createRuntimeTools(): RuntimeTool[] {
  return [
    ...createHitlTools(),
    ...createBasicTools(),
    ...createArtifactTools(),
    ...createFilesystemTools(),
    ...createBrowserTools(),
  ];
}

export function createPlannerStepRuntimeTools(): RuntimeTool[] {
  return [
    ...createRuntimeTools(),
    ...createPlannerStepTools(),
  ];
}
```

删除 `createPlannerTools` import/export 及 `src/tools/planner-tools.ts`。Code tools 保持原集合。

- [ ] **Step 4: 运行工具测试**

Run: `npx vitest run tests/runtime-tools.test.ts && npm run typecheck`

Expected: PASS，且源码扫描无 planner-as-tool 名称。

---

### Task 4: 实现独立 PlannerReactAgent 的 direct 与 plan 主流程

**Files:**

- Create: `src/orchestration/planner-react-agent.ts`
- Modify: `src/orchestration/index.ts`
- Test: `tests/planner-react-agent.test.ts`

- [ ] **Step 1: 写 direct route 失败测试**

```ts
it('creates only one react root task for a direct route', async () => {
  planner.routeGoal.mockResolvedValue({ route: { mode: 'direct_answer', reason: 'simple' } });
  await agent.run({ sessionId: 'session_1', goal: '你好' });
  expect(await store.listTasks('session_1')).toMatchObject([
    { kind: 'react', executor: 'react', parentTaskId: undefined, status: 'completed' },
  ]);
});
```

- [ ] **Step 2: 写 plan route 失败测试**

```ts
it('creates a planner root and sequential planner_step children', async () => {
  planner.routeGoal.mockResolvedValue({ route: { mode: 'plan', reason: 'complex' } });
  planner.createPlan.mockResolvedValue({ plan });
  await agent.run({ sessionId: 'session_1', goal: '调研并写报告' });
  expect(await store.listTasks('session_1')).toMatchObject([
    { kind: 'planner', executor: 'planner', status: 'completed' },
    { kind: 'planner_step', executor: 'react', metadata: { stepId: 'step_1' }, status: 'completed' },
    { kind: 'planner_step', executor: 'react', metadata: { stepId: 'step_2' }, status: 'completed' },
  ]);
});
```

- [ ] **Step 3: 实现配置与公开入口**

```ts
export interface PlannerReactAgentConfig {
  store: AgentSessionStore;
  contextBuilder: ContextBuilder;
  planner: PlannerCore;
  directReact: ReactCore;
  stepReact: ReactCore;
  routerSystemPrompt?: string;
  plannerSystemPrompt?: string;
  reactSystemPrompt?: string;
  plannerFinalSystemPrompt?: string;
  timeZone?: string;
  sandboxRoot?: string;
  modelName?: string;
  ids?: IdFactory;
  clock?: Clock;
  onEvent?: (event: AgentSessionPatch) => void | Promise<void>;
}

export class PlannerReactAgent {
  async run(input: { sessionId: string; goal: string }): Promise<AgentRunResult>;
  async answerInputRequest(input: { sessionId: string; requestId: string; value: unknown }): Promise<AgentRunResult>;
}
```

- [ ] **Step 4: 实现主状态机**

`run()` 按以下固定顺序：

```ts
await ensureSession(sessionId, 'planner_react');
await assertNoActiveRootTask(sessionId);
const route = await routeGoal(goal);
if (route.mode === 'direct_answer') return runDirectTask(sessionId, goal);
return runPlannedTask(sessionId, goal);
```

`runPlannedTask()` 必须：创建 planner root、写 user goal、写 plan message、逐步创建 child task、对每步调用 `runStepTask()`、确认 step result、finalize、写 `planner_final`、完成 root。plan message 使用：

```ts
{
  role: 'assistant',
  messageKind: 'plan',
  visibility: 'ui',
  content: plan.title,
  metadata: { kind: 'plan', planId: plan.id, plan },
}
```

- [ ] **Step 5: 实现 step result gate**

`runStepTask()` 仅在找到以下消息时完成：

```ts
message.taskId === stepTask.id
  && message.messageKind === 'step_result'
  && message.metadata?.stepId === step.id
```

缺失时抛出 `Planner step completed without step_result: ${step.id}`，root 与 child 进入 failed。

- [ ] **Step 6: 运行编排主流程测试**

Run: `npx vitest run tests/planner-react-agent.test.ts`

Expected: direct/plan/step gate PASS。

---

### Task 5: 实现 Planner Step HITL 与进程重启式恢复

**Files:**

- Modify: `src/orchestration/planner-react-agent.ts`
- Test: `tests/planner-react-agent.test.ts`

- [ ] **Step 1: 写暂停状态失败测试**

构造 step React 同时触发两个 `ToolInputRequired`，断言：

```ts
expect(stepTask).toMatchObject({
  status: 'waiting_user_input',
  waitingRequestIds: ['input_1', 'input_2'],
});
expect(rootTask).toMatchObject({ status: 'waiting_user_input' });
```

- [ ] **Step 2: 写部分回答不恢复测试**

回答 `input_1` 后断言 model call 数不增加，child/root 仍 waiting；回答 `input_2` 后才进入 resuming/running。

- [ ] **Step 3: 写新实例恢复测试**

暂停后丢弃旧 `PlannerReactAgent` 实例，使用同一个 store 创建新实例回答请求，断言继续的是相同 `planner_step.taskId`，不会重建 plan 或重跑已完成 step。

- [ ] **Step 4: 实现恢复定位**

```ts
const request = await requirePendingRequest(sessionId, requestId);
const task = await requireTask(request.taskId);
if (task.kind === 'planner_step') {
  const root = await requireTask(task.parentTaskId);
  await persistAnswerAsToolResult(request, value);
  if (await hasPendingRequests(task.id)) return waitingResult(root, task);
  await transitionBothToRunning(root, task);
  return continuePlannedRun(root, task);
}
if (task.kind === 'react') {
  return resumeDirectTask(task, request, value);
}
throw new Error(`Unsupported task kind for PlannerReactAgent resume: ${task.kind}`);
```

`continuePlannedRun()` 从 store 加载最新 plan、按 `stepId` 找当前 index、用 projection 重建 current step context，完成后从下一个未完成 step 继续；finalization 已完成时不得重复生成 final。

- [ ] **Step 5: 运行 HITL 测试**

Run: `npx vitest run tests/planner-react-agent.test.ts`

Expected: pause、partial answer、full resume、new-instance resume 全部 PASS。

---

### Task 6: 接回 Qwen Runtime 与 NestJS 唯一入口

**Files:**

- Modify: `src/server/runtime/qwen-runtime.ts`
- Modify: `src/server/http/tokens.ts`
- Modify: `src/server/http/server.module.ts`
- Modify: `src/server/http/agent-runtime.service.ts`
- Modify: `src/server/main.ts`
- Modify: `tests/api.test.ts`

- [ ] **Step 1: 扩展 QwenRuntime**

```ts
export interface QwenRuntime {
  contextBuilder: ContextBuilder;
  planner: PlannerCore;
  react: ReactCore;
  plannerStepReact: ReactCore;
  code: ReactCore;
  modelName: string;
}
```

构造三个 tool-bound model：general、planner-step、code；再构造一个不绑定 tools 的 planner model。`plannerStepReact` 使用 `createPlannerStepRuntimeTools()`。

- [ ] **Step 2: 恢复 DI token**

```ts
export const AGENT_PLANNER_CORE = Symbol('AGENT_PLANNER_CORE');
export const AGENT_PLANNER_STEP_REACT_CORE = Symbol('AGENT_PLANNER_STEP_REACT_CORE');
```

`AgentServerModuleOptions` 增加：

```ts
planner: PlannerCore;
plannerStepReact: ReactCore;
```

- [ ] **Step 3: 服务层只实例化 PlannerReactAgent**

```ts
runReact(sessionId: string, input: string) {
  return this.runPlannerReact(sessionId, input);
}

runPlannerReact(sessionId: string, goal: string) {
  return this.createPlannerAgent(sessionId).run({ sessionId, goal });
}
```

`answerInputRequest()` 对 `code` task 使用 `CodeAgent`，其余 `react/planner_step` 一律使用新 `PlannerReactAgent`。不得再直接 new `ReactAgent` 作为 HTTP 普通入口。

- [ ] **Step 4: 更新 main 注入与 API 测试**

`AgentServerModule.register()` 传入 `planner` 和 `plannerStepReact`。API 测试断言 `/react/runs` 和 `/planner-react/runs` 最终调用同一 service 编排方法。

- [ ] **Step 5: 运行 API 与类型测试**

Run: `npx vitest run tests/api.test.ts && npm run typecheck`

Expected: PASS。

---

### Task 7: 删除 ReactAgent/View 中 planner-as-tool 专有逻辑

**Files:**

- Modify: `src/orchestration/react-agent.ts`
- Modify: `src/orchestration/system-prompts.ts`
- Modify: `src/view/session-view.ts`
- Modify: `tests/orchestrator.test.ts`
- Modify: `tests/session-view.test.ts`

- [ ] **Step 1: 删除旧编排测试**

删除“ReactAgent persists planner tool results”测试，新增扫描式断言：普通 React model 即使请求 `create_plan`，只会得到标准 `Tool not found`，不会产生 `plan` message。

- [ ] **Step 2: 删除 ReactAgent 中专有类型与方法**

删除：

```text
StoredPlan
StoredPlanStep
PlannerToolResult
applyPlannerToolResult
findRunningPlanStep
isPlannerToolName
所有 source='planner_tool' 的 message 复制逻辑
```

保留通用 core event -> message/patch 映射、HITL、token usage 完成逻辑。

- [ ] **Step 3: 修改 REACT_SYSTEM_PROMPT**

删除 Planner 是工具能力以及 `create_plan/update_plan/set_plan_step_status` 使用规则。替换为：

```md
# Scope

你只负责完成编排器交给你的当前目标。不要自行创建或维护跨任务计划。
如果当前目标是 Planner 的一个步骤，只执行该步骤；完成时按可用工具协议提交稳定步骤结果。
```

- [ ] **Step 4: 简化 Session View**

删除 `isPlannerToolMessage/isPlannerToolName` 过滤。`buildGroupedTimeline()` 只按 plan message、`planner_step` task 和 `stepId` 聚合；平铺 `messages` 不做额外转换。

- [ ] **Step 5: 运行编排与 view 测试**

Run: `npx vitest run tests/orchestrator.test.ts tests/session-view.test.ts`

Expected: PASS。

---

### Task 8: 文档、全量验证与残留扫描

**Files:**

- Modify: `docs/runtime-architecture-overview-zh.md`
- Modify: `docs/nestjs-api.md`
- Verify: `src/`、`tests/`、`dist/`

- [ ] **Step 1: 更新架构文档**

文档统一使用：`PlannerReactAgent -> PlannerCore(route/create/final) -> ReactCore(direct/step)`；删除“Planner 是 React 工具能力”的描述。

- [ ] **Step 2: 运行定向测试**

Run:

```bash
npx vitest run \
  tests/planner-core.test.ts \
  tests/planner-context-projection.test.ts \
  tests/planner-react-agent.test.ts \
  tests/runtime-tools.test.ts \
  tests/session-view.test.ts \
  tests/api.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 3: 运行全量验证**

Run: `npm test && npm run typecheck && npm run build`

Expected: 所有测试通过，TypeScript/build exit code 0。

- [ ] **Step 4: 扫描错误路径残留**

Run:

```bash
rg -n "create_plan|update_plan|set_plan_step_status|createPlannerTools|supportsRouting|source: 'planner_tool'" src tests dist
```

Expected: 无输出。

- [ ] **Step 5: 扫描唯一入口**

Run:

```bash
rg -n "new PlannerReactAgent|new ReactAgent" src/server src/orchestration
```

Expected:

- HTTP 普通 Agent 路径只出现 `new PlannerReactAgent`。
- `new ReactAgent` 不出现在 HTTP 普通 Agent 入口。
- Code Agent 入口保持独立。

- [ ] **Step 6: 记录 Git 限制**

当前 `/Users/hanljjie/Desktop/Agent/agent-runtime-v2` 不在 Git worktree 中，不能执行逐任务 commit。实施时保留每个 Task 的测试检查点；如果用户后续将目录纳入 Git，再按 Task 边界提交。

---

## 自检结论

- 规格中的 direct route、complex plan、step result gate、HITL、重启恢复、上下文投影、工具隔离、唯一 HTTP 入口均有对应任务。
- 类型命名统一为 `PlannerCore`、`PlannerReactAgent`、`plannerStepReact`、`PlannerPlan`、`PlannerStep`。
- 没有恢复 `supportsRouting`，路由是 `PlannerCore` 的强制能力。
- `submit_step_result` 仅属于 planner step runtime，不属于 planner-as-tool。
- `ReactCore` 不增加 Planner 分支。
