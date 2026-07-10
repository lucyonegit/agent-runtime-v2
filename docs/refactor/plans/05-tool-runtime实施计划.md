# Tool Runtime 与 Direct Job 实施计划

**Goal:** 将 AgentLoop 事件接入 canonical ToolInvocation、message 和 Job 事务，跑通 direct Job 的工具执行、最终消息与 HITL 恢复。

### Task 1: ToolInvocation transaction boundary

- Extend: `src/storage/agent-store.ts`
- Extend: `src/storage/postgres/row-mappers.ts`
- Extend: `src/storage/postgres/transaction-commands.ts`
- Create: `src/runtime/tool-executor.ts`

- [ ] tool-call message 与全部 pending invocation 同事务提交。
- [ ] ToolExecutor 只能执行成功 claim 的 invocation。
- [ ] claim 同时校验 Job lease、worker 和 attempt。
- [ ] tool-result message 与 invocation 终态同事务提交。
- [ ] side-effecting running 失联不得自动重放。

### Task 2: RuntimeEventWriter and AgentRunner

- Create: `src/runtime/runtime-event-writer.ts`
- Create: `src/runtime/agent-runner.ts`
- Create: `src/runtime/transaction-commands.ts`

- [ ] generator 每个事件完成持久化/发布后才 next。
- [ ] delta 只发布不落库。
- [ ] tool calls、tool results、final message 使用对应原子 Store command。
- [ ] LoopResult completed/failure/waiting/cancelled 映射到 Job 状态。

### Task 3: Multi-input waiting and resume

- Extend AgentStore with `createInputRequestsAndMarkWaiting` and `answerInputAndClaimResume`.
- [ ] 同批所有 request 一次提交。
- [ ] 回答 tool request 必须写 tool-result message。
- [ ] 最后一个并发回答才 claim resume，其他回答 `shouldResume=false`。
- [ ] Direct Job fake model/tool 端到端测试覆盖刷新后的 committed entities。
