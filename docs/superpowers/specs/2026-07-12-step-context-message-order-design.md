# Step Context 消息时序修复设计

## 问题

当前 `StepContextLoader` 将当前 Step 指令放进 `fixedMessages`，`ContextCompiler` 又固定先输出 fixed messages、后输出历史 MessageGroup。因此模型看到“当前指令”之后还有完整 Session/Plan 历史，历史中的未解决事项和已完成动作会覆盖当前指令，造成工具调用整体提前一步。

数据库事实已经证明：第 3 步调用了 `request_user_input`，第 4 步调用了 `write_article`，第 5 步只重复第 4 步结果；前端按 `stepId + rowId` 的展示没有错。

## 正常时序

Step 模型输入固定为：

```text
Runtime System
Stable Context（可选）
完整 Plan
Session 基线
先前 StepRun / ToolResult / StepOutput
当前 StepRun 已有恢复尾部
当前 Step 指令
```

当前 Step 指令必须是初始或恢复 Context 的最后一条消息，并明确禁止执行后续 PlanStep。

## 实现

- `ContextMaterial` 增加可选 `trailingMessages`，类型与 `fixedMessages` 相同。
- `ContextCompiler` 在所有 summary/group item 之后加入 trailing messages；它们仍是 must-keep system 类目，并纳入 token 预算和 Manifest breakdown。
- `StepContextLoader` 将当前 Step 指令从 `fixedMessages` 移到 `trailingMessages`。
- Context 规则版本从 `job-step-run-context-v4` 升为 `job-step-run-context-v5`，避免把新旧消息顺序误判为同一规则。
- DirectJob、Session Preview、压缩、ModelCall 重建沿用现有路径；没有 trailing messages 时行为完全不变。

## 约束

- 不改变数据库 schema、Store、事务或 Message rowId。
- 不改变 TimelineBuilder 或前端排序。
- 不删除完整 Session、Plan、历史 StepRun 与 StepOutput。
- 不改变 ReAct、HITL 或 retry 状态机。

## 验证

- Step Context 的最后一条 LangChain Message 是强化后的当前指令。
- 当前 StepRun 恢复尾部位于指令之前，tool call/result pair 保持完整。
- Direct Context 输出顺序不变。
- typecheck、单元测试、PostgreSQL 集成测试和 build 全部通过。
