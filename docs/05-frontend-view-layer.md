# 05. 前端接入层 View 设计

## 目标

前端不应该理解 Postgres 表，也不应该自己拼装 Job、Plan、Message、ToolInvocation 的关系。前端只消费两个数据源：

1. `GET /sessions/:sessionId/view` 返回完整快照。
2. `GET /sessions/:sessionId/events` 返回实时增量。

完整快照的 contract 是 `SessionViewV1`，定义在 `src/view/view-contract.ts`。

## SessionViewV1

字段：

- `schemaVersion`
- `generatedAtMs`
- `session`
- `jobs`
- `plans`
- `planSteps`
- `stepRuns`
- `messages`
- `toolInvocations`
- `userInputRequests`
- `modelUsage`
- `timeline`
- `cursor.latestMessageRowId`

设计原则：

- entity arrays 保留完整结构，方便前端做详情面板。
- `timeline.flat` 用于普通聊天流。
- `timeline.groupedByStep` 用于 planned Job 的步骤视图。
- `cursor.latestMessageRowId` 用于判断消息是否新增。

## Timeline 投影

`TimelineBuilder` 输出两种视图：

### `timeline.flat`

按 `rowId` 排序，包含：

- `message`：普通消息。
- `tool_exchange`：tool call 和 tool result 聚合后的工具交换。

`tool_exchange` 包含：

- `callMessage`
- `invocations`
- `resultMessages`
- `status`
- `warning`

这样前端不用自己把 tool call 和 tool result 配对。

### `timeline.groupedByStep`

按 Job 分组，再按 PlanStep 和 StepRun 分组。

用途：

- planned Job 页面。
- Step 执行状态展示。
- 当前步骤高亮。
- 单步失败、等待输入、重试历史展示。

结构：

- `job_group`
  - direct message/tool items
  - `step_group`
    - step definition
    - step run
    - step 内 messages / tool exchanges

## 前端状态管理建议

前端维护一个 SessionView store：

```ts
interface SessionViewState {
  snapshot?: SessionViewV1;
  streamMessages: Record<string, string>;
  connected: boolean;
  lastLoadedAtMs?: number;
}
```

更新策略：

1. 打开 Session 时先拉 `/view`。
2. 建立 SSE。
3. 收到 `message.delta` 时写入 `streamMessages[messageId]`。
4. 收到 `message.upserted` 时用正式 message 覆盖，并清理对应 delta。
5. 收到其他 `*.upserted` 时更新对应 entity。
6. 遇到 SSE 断线或未知事件顺序，重新拉 `/view`。

## 组件划分建议

### SessionShell

职责：

- 加载 SessionView。
- 管理 SSE 生命周期。
- 提供 retry/cancel/answer 操作。
- 处理断线重连。

### TimelineView

职责：

- 渲染 `timeline.flat`。
- 根据 message type 选择展示组件。
- 对 streaming delta 做临时合并显示。

### PlannedJobView

职责：

- 渲染 `timeline.groupedByStep`。
- 展示 Plan、Step 状态和 StepRun。
- 当前 StepRun running 时自动展开。

### ToolExchangeCard

职责：

- 展示工具名、参数摘要、状态、结果。
- `unknown` 状态展示恢复警告。
- `waiting_user_input` 状态连接 UserInputRequest。

### UserInputPanel

职责：

- 展示 pending `userInputRequests`。
- 根据 `inputSchema` 渲染 text、single choice、multi choice、approval。
- 提交时带 `expectedVersion` 和 `clientAnswerId`。

### DebugContextPanel

职责：

- 调用 `/context-preview`。
- 展示 manifest、token breakdown、selected bundles、messages。
- 只在开发/调试入口显示。

## 敏感信息投影

`SessionView` 会对 `metadata.sensitiveAnswer = true` 的请求做投影：

- request 中移除 `answer` 和 `clientAnswerId`。
- answer message 内容替换为 `[Sensitive answer hidden]`。
- tool invocation 移除 `resultPayload`。
- tool result message 只保留 status 和 duration。

前端仍要遵守：

- 不在日志中打印 answer payload。
- 不把 Debug Context 暴露给普通用户。
- 对敏感输入组件禁用本地持久化。

## 用户动作

### 创建 Job

1. 生成 `clientRequestId`。
2. POST `/sessions/:sessionId/jobs`。
3. 乐观插入可选 pending 状态。
4. 等待返回和 SSE。
5. 如果请求失败但网络不确定，可用同一个 `clientRequestId` 重试。

### 取消 Job

1. 从最新 view 读取 job.version。
2. POST `/jobs/:jobId/cancel`。
3. 如果 409，重新拉 view 后提示状态已变化。

### 回答输入请求

1. 从 request 读取 `version`。
2. 生成 `clientAnswerId`。
3. POST `/user-input-requests/:requestId/answer`。
4. 提交后禁用输入框，等待 `user_input.upserted` 和 `job.upserted`。

### 重试 Job

1. 只允许 failed Job 展示 retry。
2. 生成新的 `clientRequestId`。
3. 可选择沿用原始目标或提交新 message。
4. POST `/jobs/:jobId/retry`。

## Loading 和恢复

前端应把 `/view` 当作 authoritative recovery：

- 首次进入页面。
- SSE 重连。
- 收到未知 entity。
- 本地 version 冲突。
- 用户手动刷新。
- Debug 面板打开前。

不建议前端仅凭 SSE 维护长期状态，因为 message delta 和 entity upsert 可能乱序或丢失。

