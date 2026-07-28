# Agent Runtime 文档

当前 Runtime 只维护一套模型、一套 schema 和一套执行语义。阅读顺序：

1. [核心模型与架构](./00-core-model-and-architecture.md)
2. [数据库与状态机](./01-database-and-state-machines.md)
3. [执行、恢复与 HITL](./02-execution-recovery-and-hitl.md)
4. [Context、Plan、View 与事件](./03-context-plan-view-and-events.md)
5. [运行、重置与验证](./04-operations-and-validation.md)

核心原则：

- `Session` 是长期对话和工作区。
- `Task` 是一次用户目标。
- `TaskRun` 是一次实际执行窗口。
- `ToolCall` 是模型发出的逻辑调用。
- `ToolRun` 是一次物理工具执行。
- `RuntimeMessage` 是 LangChain 协议和工具结果的唯一消息事实。
- `ActivePlan` 是当前 Session 的临时 UI 状态，终态即清除。
- `ContextCompaction` 只是模型输入缓存，不是长期 Memory。
