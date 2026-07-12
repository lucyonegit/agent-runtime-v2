# 06. Debug 查看 Context 能力设计

## 目标

Debug Context 能力用于回答三个问题：

1. 下一次模型调用会看到什么？
2. 某一次历史 ModelCall 实际看到了什么？
3. 为什么某些消息被选中、摘要、截断或阻塞？

它必须是只读能力，不改变 Job、Message、Summary 或 ModelCall 状态。

## 当前能力

当前 HTTP 已暴露四类入口：

```http
GET /sessions/:sessionId/context-preview
GET /jobs/:jobId/context-preview
GET /step-runs/:stepRunId/context-preview
GET /model-calls/:modelCallId/context
```

它们都调用：

- `ContextPreviewService.preview(sessionId)`
- `ContextPreviewService.previewJob(jobId)`
- `ContextPreviewService.previewStepRun(stepRunId)`
- `ContextPreviewService.previewModelCall(modelCallId)`
- `ContextInspectionService.inspect({ kind: 'next_turn', sessionId })`
- `ContextInspectionService.inspect({ kind: 'job', jobId })`
- `ContextInspectionService.inspect({ kind: 'step_run', stepRunId })`
- `ContextInspectionService.inspect({ kind: 'model_call', modelCallId })`

返回 `ContextPreviewV1`。

## ContextPreviewV1 字段

| 字段 | 作用 |
| --- | --- |
| `schemaVersion` | Debug API contract 版本 |
| `debugOnly` | 明确不能作为主业务数据 |
| `generatedAtMs` | 生成时间 |
| `sessionId` | 会话 |
| `basedOnLatestJobId` | 基于哪个最新 Job |
| `contextRulesVersion` | Context 规则版本 |
| `systemPromptVersion` | 系统提示词版本 |
| `estimatedInputTokens` | 估算输入 token |
| `compressionRecommended` | 是否建议压缩 |
| `limits` | max context 和 reserved output |
| `manifest` | Context 输入清单 |
| `selection` | bundle、summary、truncated tool result 选择 |
| `blockedDiagnostics` | 不完整 tool exchange 诊断 |
| `messages` | 最终会发给模型的消息 |

## Messages 展示

每条 preview message 包含：

- `index`
- `type`：system、human、ai、tool。
- `content`
- `name`
- `toolCallId`
- `toolCalls`
- `source`

`source` 来自 `CompiledContextAnnotation`：

- `sourceMessageId`
- `groupId`
- `bundleId`
- `projected`
- `truncated`
- `originalTokenEstimate`
- `projectedTokenEstimate`
- `checksum`

前端 Debug 页面应按 message index 展示，同时提供按 group/bundle 过滤。

## Next Turn Preview 限制

如果 Session 有 active Job，`next_turn` preview 会拒绝：

- `created`
- `running`
- `waiting_user_input`
- `resuming`

原因：active Job 期间上下文仍在变化，预览下一轮会误导调试。

此时前端应提示：

> 当前 Session 有执行中的 Job，下一轮 Context 暂不可预览。请等待 Job 结束，或查看具体 ModelCall 的历史 Context。

## 历史 ModelCall 复原

已暴露 API：

```http
GET /model-calls/:modelCallId/context
```

内部调用：

```ts
ContextInspectionService.inspect({
  kind: 'model_call',
  modelCallId
})
```

复原过程：

1. 读取 `agent_model_calls`。
2. 根据 `step_run_id` 判断 direct context 或 step context。
3. 使用 call 的 `inputManifest.contextRulesVersion` 加载 material。
4. 只保留 manifest 中记录的 group、summary、bundle。
5. 重新 compile。
6. 校验 manifest 和 `inputChecksum`。
7. 返回 `verification.status = exact`。

如果校验失败，说明：

- 底层消息被删除或破坏。
- summary 不存在。
- context rules version 已不支持。
- tool schema 或 fixed prefix 不一致。

这类错误应明确展示为“无法复原”，而不是降级返回不准确 Context。

## Job / StepRun Preview

已暴露 API：

```http
GET /jobs/:jobId/context-preview
GET /step-runs/:stepRunId/context-preview
```

用途：

- Job preview：查看 direct Job 将使用的 Context。
- StepRun preview：查看某个 PlanStep 执行时的 Context。

注意：

- planned Job 不应直接通过 Job preview 查看，因为真正模型调用发生在 StepRun。
- `ContextInspectionService` 已经对 planned Job 的 job preview 抛错，提示必须看 StepRun 或 ModelCall。

## Debug 页面信息架构

建议前端 DebugContextPanel 分成六块：

### 1. Header

- Session ID。
- basedOnLatestJobId / modelCallId。
- contextRulesVersion。
- systemPromptVersion。
- generatedAt。
- verification status。

### 2. Token Summary

- estimatedInputTokens。
- maxContextTokens。
- reservedOutputTokens。
- estimatedBreakdown：system、tools、summaries、messages、reservedOutput。
- compressionRecommended。

### 3. Selection

- selectedBundleIds。
- summarizedBundleIds。
- summaryIds。
- messageGroupIds。
- truncatedToolResultMessageIds。

### 4. Blocked Diagnostics

展示不完整 tool exchange：

- messageId。
- toolCallId。
- reason。

如果有 blocked diagnostics，页面应高亮警告，因为这通常代表 tool call/result 写入链路异常。

### 5. Prompt Messages

按顺序展示最终模型输入：

- system。
- human。
- ai。
- tool。

每条消息展示 sourceMessageId、groupId、bundleId、是否 truncated/projected。

### 6. Raw Manifest

提供 JSON viewer，方便复制给后端排查。

## 安全策略

Debug Context 可能包含：

- system prompt。
- tool schema。
- 用户输入。
- 工具结果。
- 被 UI 隐藏的 internal 上下文。

因此建议：

1. 只在开发环境或管理员权限开放。
2. 请求和响应都不进入普通业务埋点。
3. 前端默认折叠 system prompt 和 tool result。
4. sensitive answer 即便在 Debug 也应考虑脱敏开关。
5. 导出功能必须显示风险提示。

## 验收标准

Debug Context 能力完成后，应能支持：

- 查看一个空闲 Session 下一轮将发送给模型的完整 messages。
- 查看 token breakdown 和 selected bundle。
- 看到哪些历史 turn 被 summary 覆盖。
- 看到 tool result 是否被截断。
- 对历史 ModelCall 做 exact reconstruction。
- 当 Context 无法复原时，给出明确 missing group / summary / checksum 错误。
