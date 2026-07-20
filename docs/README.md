# Agent Runtime v2 当前设计

当前 Runtime 采用一个 Job 对应一个持久化 ReAct 循环的架构。复杂任务不会切换到另一套 Planner/StepRun 执行器；Plan 是 ReAct 可调用的特权工具 `update_plan`，用于保存用户可见、可审计的任务进度。

## 文档索引

1. [统一 ReAct Runtime](./01-unified-react-runtime.md)：职责边界、执行流程、Plan 协议、HITL 与失败语义。
2. [持久化、Context 与 View](./02-persistence-context-view.md)：表模型、上下文编译、ModelCall 审计、SSE 和刷新一致性。
3. [HTTP、运行与验收](./03-http-operations.md)：接口、环境、schema 管理和验收清单。

## 已删除的旧概念

- `StrategyRouter` 与 direct/planned 双执行链路。
- `PlanExecutor`、`StepExecutor`、`PlanFinalizer`。
- `StepRun` 领域对象、表、外键、事件和前端卡片。
- `step_execution`、`plan_final` 等嵌套 Context purpose。
- 模型可见的 Plan `expectedVersion`。

数据库仍保存 Job、Plan、PlanStep、Message、ToolInvocation、UserInputRequest、ModelCall 和 ContextSummary 等业务事实；执行核心以后可以替换，但这些可审计事实不依赖某个图框架的 checkpoint。
