# Runtime 重构文档索引

这组文档描述的是 **Agent Runtime V2 的目标重构**，不是“当前代码已经完全实现”的声明。推荐按以下顺序阅读：

1. [决策记录与现状审计](./00-决策记录与现状审计.md)
   - 汇总此前讨论结论、否决方案、当前实现的根问题。
2. [目标运行时架构](./01-目标运行时架构.md)
   - 模块边界、ReAct/Planner/HITL/恢复/SSE/View 的完整运行链路。
3. [存储与上下文设计](./02-存储与上下文设计.md)
   - 表职责、字段、约束、tool pair、snapshot、token、compression 与 schema 初始化原则。
4. [分阶段重构实施计划](./03-分阶段重构实施计划.md)
   - 第一版实施拆分，保留作历史参考。
5. [命名优化方案](./04-命名优化方案.md)
   - 命名候选与认知成本分析；新设计只选择性采用其中结论。
6. [修订版分阶段实施计划](./05-修订版分阶段实施计划.md)
   - P0 一致性风险修订记录，保留作方案演进参考。
7. [完整 Job + StepRun 架构设计](./06-完整Job-StepRun架构设计.md)
   - 当前 canonical design candidate；包含命名、模块、表结构、状态机、事务、恢复、Context、SSE、API、测试和交付顺序。

当 01–05 与 06 的目标命名、表结构或恢复语义冲突时，以 06 为准。

## 一句话架构

`agent_messages` 是唯一会话事实时间线；`Job` 是工作流与 lease 边界；`StepRun` 是 PlanStep 的执行 checkpoint；`ToolInvocation` 保存每个工具调用的恢复状态；`ContextBuilder` 按 purpose 投影；UI 与 SSE 消费提交后的同一批实体。

## 当前执行建议

先审阅第 06 篇并确认 canonical design；确认后基于该设计另行生成逐任务实施计划。不要直接执行第 03 或第 05 篇，因为它们没有完整表达最终的 Job + StepRun 表结构与 ToolInvocation 恢复语义。
