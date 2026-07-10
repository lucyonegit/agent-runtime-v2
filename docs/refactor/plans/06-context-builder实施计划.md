# ContextBuilder 实施计划

**Goal:** 建立统一 context 入口，保证 tool exchange 不可拆分、StepRun raw history 隔离、mandatory token 不被静默截断，并输出可审计 input manifest。

- [ ] 定义 ContextPurpose 和 purpose 允许矩阵。
- [ ] 从 Message + ToolInvocation 构造 single/tool_exchange/step_output；不完整组阻塞。
- [ ] TokenBudget 先验证 mandatory hard limit，再按完整 group 选择 optional。
- [ ] ContextFormatter 生成合法 LangChain tool protocol messages。
- [ ] ContextBuilder 输出 messages、token estimate、rules version 和 manifest。
- [ ] ContextSummaryManager 使用 candidate token 触发压缩，context_compression 禁止递归。
