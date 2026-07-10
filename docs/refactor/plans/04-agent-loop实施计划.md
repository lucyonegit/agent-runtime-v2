# AgentLoop 最终结构实施计划

**Goal:** 将唯一保留的旧 ReAct core 迁入最终 `src/agent-loop` 结构，修复事件提交顺序，并让每次运行都有可消费的显式 `LoopResult`。

**Architecture:** `AgentLoop` 只依赖模型端口、工具执行端口和 LangChain message contract；模型流式 tool chunk 由独立 assembler 组装；loop 在执行任何工具前先 yield 完整 model output，依靠 AgentRunner 的逐事件 await 形成持久化 backpressure。

### Task 1: Final contracts and assembler

- Create: `src/agent-loop/model-port.ts`
- Create: `src/agent-loop/loop-events.ts`
- Create: `src/agent-loop/loop-result.ts`
- Create: `src/agent-loop/tool-call-assembler.ts`

- [ ] 使用 Job/StepRun/attempt target 命名，删除旧 `taskId` 和 `resumeMode`。
- [ ] 组装多 chunk、乱序 index、fallback ID。
- [ ] invalid JSON、非 object args、name 冲突不得静默 filter。

### Task 2: AgentLoop ordering and terminal results

- Create: `src/agent-loop/agent-loop.ts`
- Create: `tests/agent-loop.test.ts`

- [ ] model tool-call event 被 consumer 确认后才执行工具。
- [ ] 同批工具串行执行；稳定结果先输出，HITL 请求完整输出后暂停。
- [ ] completed、waiting_user_input、empty output、max iterations、max tool calls、deadline、cancelled、model error 都返回显式结果。
- [ ] 单个工具失败不阻断同轮其他工具。

### Task 3: Remove legacy core path

- Delete: `src/core/**`
- Delete: `tests/react-core.test.ts`
- Modify: `src/index.ts`

- [ ] 所有 import 改为 `src/agent-loop/*`。
- [ ] typecheck、build、普通测试和 PostgreSQL 测试全部通过。
