# Agent Runtime v2 当前设计

当前 Runtime 采用一个 Job 对应一个持久化 ReAct 循环的架构。复杂任务不会切换到另一套 Planner/StepRun 执行器；Plan 是 ReAct 可调用的特权工具 `update_plan`，用于保存用户可见、可审计的任务进度。

## 文档索引

0. [当前实现全链路](./00-current-runtime-full-chain.md)：以当前代码为准，从 HTTP、Job、ReAct、Plan、工具、HITL、Checkpoint、Context、数据库、SSE 一直追踪到前端 View，并列出当前边界与风险。这是理解现状的主文档。
1. [统一 ReAct Runtime](./01-unified-react-runtime.md)：职责边界、执行流程、Plan 协议、HITL 与失败语义。
2. [持久化、Context 与 View](./02-persistence-context-view.md)：表模型、上下文编译、ModelCall 审计、SSE 和刷新一致性。
3. [HTTP、运行与验收](./03-http-operations.md)：接口、环境、schema 管理和验收清单。
4. [统一 Context 拼接、压缩与 Token 用量策略](./04-context-compression-token-strategy.md)：基于稳定 MessageGroup 的精确覆盖、统一 Context Memory、provider usage 校准与每轮 ReAct 预算。
5. [后续 TODO 路线图](./05-runtime-roadmap-todo.md)：恢复闭环、调度背压、安全隔离、Durable SSE、历史精确回查、模型治理和故障评测的优先级与验收标准。
6. [Job 执行所有权、写入围栏与故障恢复](./06-job-execution-ownership-and-recovery.md)：执行权有效期、定期刷新、Attempt fence、服务崩溃、人工 Resume 和工具副作用恢复的专项说明。
7. [Context 压缩服务实现级设计](./07-context-compression-service-deep-dive.md)：逐步说明压缩触发、Group 选择、压缩前后 LangChain Messages、ContextMemory 数据结构、PostgreSQL 版本链、多轮滚动压缩、失败降级和当前实现风险。
8. [Runtime 状态机总览](./08-runtime-state-machines.md)：完整定义 Session、Job、LoopCheckpoint、ToolInvocation/Attempt、HITL、Plan、ModelCall、ContextSummary 和本地 ManagedProcess 的状态、迁移条件与跨实体不变量。
9. [PostgreSQL 数据库表字典与事务关系](./09-database-table-reference.md)：逐表说明当前 schema v5 的 14 张有效表、字段职责、约束、索引、级联关系、AgentStore scope、跨表原子事务和诊断 SQL。
10. [HITL、故障恢复、Retry 与 Continue-as-new 操作手册](./10-hitl-recovery-retry-playbook.md)：对比同 Job Resume、HITL 恢复、新 Job Retry、新消息 Continue-as-new 和 Cancel，提供时序图、故障注入案例、前端规则及当前缺口。

其余文档是专题说明。状态、表结构和恢复语义分别以 08、09、10 号文档为最新解释；其他链路仍以“当前实现全链路”和代码为准。

## 已删除的旧概念

- `StrategyRouter` 与 direct/planned 双执行链路。
- `PlanExecutor`、`StepExecutor`、`PlanFinalizer`。
- `StepRun` 领域对象、表、外键、事件和前端卡片。
- `step_execution`、`plan_final` 等嵌套 Context purpose。
- 模型可见的 Plan `expectedVersion`。

数据库仍保存 Job、Plan、PlanStep、Message、ToolInvocation、UserInputRequest、ModelCall 和 ContextSummary 等业务事实；执行核心以后可以替换，但这些可审计事实不依赖某个图框架的 checkpoint。
