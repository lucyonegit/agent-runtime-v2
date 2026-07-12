# 04. RESTful API 层设计

## 目标

API 层负责把 Runtime 能力以稳定 HTTP Contract 暴露给前端和调试工具。它不直接拼接上下文，不直接执行模型，也不直接操作数据库表。

当前入口：

- `src/server/main.ts`
- `src/server/http/agent-http.module.ts`
- `src/server/http/agent.controller.ts`
- `src/server/http/runtime-exception.filter.ts`

## API 总览

| Method | Path | 作用 |
| --- | --- | --- |
| POST | `/sessions` | 创建 Session |
| GET | `/sessions` | 列出 Session |
| GET | `/sessions/:sessionId/view` | 获取前端完整 SessionView |
| GET | `/sessions/:sessionId/context-preview` | Debug 预览下一轮 Context |
| DELETE | `/sessions/:sessionId` | 删除 Session |
| POST | `/sessions/:sessionId/jobs` | 创建 Job 并提交用户消息 |
| POST | `/jobs/:jobId/cancel` | 取消 Job |
| POST | `/jobs/:jobId/retry` | 重试失败 Job |
| GET | `/jobs/:jobId/context-preview` | Debug 预览 direct Job Context |
| GET | `/step-runs/:stepRunId/context-preview` | Debug 预览 PlanStep 执行 Context |
| GET | `/model-calls/:modelCallId/context` | Debug 复原历史 ModelCall Context |
| POST | `/user-input-requests/:requestId/answer` | 回答 HITL 请求 |
| SSE | `/sessions/:sessionId/events` | 订阅实时事件 |

## Session API

### `POST /sessions`

请求：

```json
{
  "title": "Optional title"
}
```

语义：

- 创建一个 active Session。
- title 可为空。
- 返回 `AgentSession`。

### `GET /sessions`

语义：

- 返回 Session 列表。
- 当前实现直接返回 store 的 `listSessions()`。
- 排序应由 store 保持稳定，通常按 `updated_at_ms desc`。

### `DELETE /sessions/:sessionId`

语义：

- 删除 Session 和级联数据。
- 清理 Session sandbox。
- 关闭该 Session 的 SSE subject。
- 成功返回 204。

注意：

- 删除是硬删除。
- 前端应在 204 后移除本地 Session 状态。

## Job API

### `POST /sessions/:sessionId/jobs`

请求：

```json
{
  "message": "用户目标",
  "clientRequestId": "client-generated-id"
}
```

语义：

1. 校验 `message` 和 `clientRequestId` 非空。
2. 创建 Job 和 user message。
3. 如果 Job 是新创建的 `created` 状态，立即 claim 为 `running`。
4. 异步调度执行。
5. 返回创建结果。

幂等：

- `clientRequestId` 在同一 Session 内唯一。
- 客户端重试同一个 request id 不应创建重复 Job。

前端要求：

- 创建请求发出后立即订阅或保持 SSE。
- 无论 SSE 是否收到完整事件，都应定期或在重连后拉取 `/view`。

### `POST /jobs/:jobId/cancel`

请求：

```json
{
  "expectedVersion": 3
}
```

语义：

- 只有 version 匹配时取消。
- 防止用户基于过期 UI 取消已变化的 Job。
- 返回更新后的 `AgentJob`。

### `POST /jobs/:jobId/retry`

请求：

```json
{
  "clientRequestId": "client-generated-retry-id",
  "message": "可选的新目标"
}
```

语义：

- 只能 retry failed Job。
- 如果不传 `message`，沿用失败 Job 的原始 goal message。
- 如果传 `message`，创建新的 user message。
- 新 Job 的 `retryOfJobId` 指向失败 Job。
- 创建后立即 claim 并调度执行。

## User Input API

### `POST /user-input-requests/:requestId/answer`

请求：

```json
{
  "expectedVersion": 1,
  "clientAnswerId": "client-generated-answer-id",
  "answer": "用户输入或审批结果"
}
```

语义：

1. 校验 `clientAnswerId` 非空。
2. 按 expectedVersion 回答 pending request。
3. 写 answer message。
4. 如果是 tool source，则把 answer 投影成 tool result。
5. Job 从 `waiting_user_input` 进入 `resuming` 并 claim。
6. 如果 `shouldResume = true`，重新调度执行。

回答模式：

- `as_tool_result`：用于工具等待用户输入，恢复时模型看到 tool result。
- `as_user_message`：用于普通澄清，恢复时模型看到用户消息。

## SSE 事件

### `GET /sessions/:sessionId/events`

返回 Nest `@Sse` Observable。事件类型来自 `AgentRealtimeEvent`：

- `message.delta`
- `message.upserted`
- `job.upserted`
- `plan.upserted`
- `plan_step.upserted`
- `step_run.upserted`
- `tool_invocation.upserted`
- `user_input.upserted`
- `model_usage.updated`

设计原则：

1. SSE 是加速 UI 更新的增量通道。
2. SSE 不是事实源。
3. 前端重连后应重新拉 `/sessions/:sessionId/view`。
4. `message.delta` 只用于流式显示，最终以 `message.upserted` 为准。
5. entity upsert event 应覆盖本地同 ID 实体。

## Context Preview API

### `GET /sessions/:sessionId/context-preview`

语义：

- 只读 Debug API。
- 当前实现预览 `next_turn`。
- 如果 Session 里存在 active Job，会返回 concurrency conflict，因为 active Job 的下一轮上下文不稳定。

返回核心字段：

- `schemaVersion`
- `debugOnly`
- `generatedAtMs`
- `contextRulesVersion`
- `systemPromptVersion`
- `estimatedInputTokens`
- `compressionRecommended`
- `limits`
- `manifest`
- `selection`
- `blockedDiagnostics`
- `messages`

同一套底层 inspection 能力也对外暴露为：

- `GET /jobs/:jobId/context-preview`：查看 direct Job 的 reconstructed Context。planned Job 应改看 StepRun 或 ModelCall。
- `GET /step-runs/:stepRunId/context-preview`：查看某个 PlanStep 执行时的 reconstructed Context。
- `GET /model-calls/:modelCallId/context`：按持久化 manifest 复原历史 ModelCall 的 exact Context。

仍可后续扩展：

- `GET /model-calls/:modelCallId/context-diff?against=next_turn`

## 错误映射

API 层应统一映射 RuntimeError 和 AgentStoreError：

- not found：404。
- concurrency conflict / version conflict：409。
- invalid state：409 或 400。
- validation error：400。
- runtime unexpected error：500。

错误响应建议：

```json
{
  "code": "concurrency_conflict",
  "message": "Context preview is unavailable while Job ... is running.",
  "details": {
    "jobId": "job_xxx",
    "status": "running"
  }
}
```

## API 层不做的事

- 不直接读写 Postgres 表。
- 不拼接模型 Context。
- 不判断 direct/planned 策略。
- 不处理 tool execution。
- 不把 internal message 暴露给普通 SessionView。
- 不把 Debug Context 当作前端主视图数据。
