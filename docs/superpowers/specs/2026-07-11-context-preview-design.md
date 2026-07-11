# 会话 Context Preview 调试入口设计

## 目标

为每个 Session 提供一个只读调试入口，展示“如果此刻开始下一轮对话，已经落库的历史会形成怎样的 LangChain Message List”。该能力用于核对 Context 过滤、消息顺序、Plan/StepOutput、ToolCall/ToolResult 配对与 TokenBudget，不创建 Job、不写数据库、不调用模型。

## 使用约束

- 仅当 Session 不存在活动 Job 时允许生成快照。
- 活动状态包括 `created`、`running`、`waiting_user_input`、`resuming`。
- 输入框中尚未发送的草稿不进入快照。
- 快照表示下一轮的“历史基础上下文”；真实下一轮仍会在末尾追加新的 `HumanMessage`。
- 空 Session 可以生成快照，此时通常只包含系统消息，工具定义只计入 Token 明细，不伪装成聊天消息。
- 接口只返回调试所需字段，不直接序列化 LangChain 对象中的 provider metadata、response metadata 或其他实现细节。

## 方案

### 服务端接口

新增：

```http
GET /sessions/:sessionId/context-preview
```

响应契约：

```ts
interface ContextPreviewV1 {
  schemaVersion: 1;
  debugOnly: true;
  generatedAtMs: number;
  sessionId: string;
  basedOnLatestJobId?: string;
  previewRulesVersion: 'context-preview-v1';
  runtimeContextRulesVersion: string;
  systemPromptVersion: string;
  estimatedInputTokens: number;
  compressionRecommended: boolean;
  limits: {
    maxContextTokens: number;
    reservedOutputTokens: number;
  };
  manifest: {
    includedMessageIds: string[];
    includedRowIdStart?: number;
    includedRowIdEnd?: number;
    omitted: Array<{
      messageId: string;
      reason: 'internal' | 'progress' | 'incomplete_tool_exchange' | 'token_budget';
    }>;
    estimatedBreakdown: {
      system: number;
      tools: number;
      messages: number;
      reservedOutput: number;
    };
  };
  messages: ContextPreviewMessage[];
}

type ContextPreviewMessage = {
  index: number;
  type: 'system' | 'human' | 'ai' | 'tool';
  content: unknown;
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
};
```

错误语义：

- Session 不存在：`404 SESSION_NOT_FOUND`。
- Session 存在活动 Job：`409 CONTEXT_PREVIEW_JOB_ACTIVE`，响应包含活动 Job ID 和状态。
- 历史中存在不完整的旧 ToolCall：调试实现不把不完整交换放进 Message List，并在 `manifest.omitted` 中标记原因。

### 调试实现隔离

Context Preview 是独立的调试实现，不修改、不调用也不扩展正式 `ContextBuilder`。新增代码全部位于 `src/server/debug/`，正式 Job、StepRun、Context 压缩和模型调用路径保持不变。

调试模块复制当前历史上下文的必要规则：

- 按 `rowId` 排序。
- 排除 `visibility = internal` 和 `messageType = progress`。
- 保留普通 User/Assistant、PlanCreated、全部 StepOutput、PlanFinal 和其他可见消息。
- ToolCall 只有在所有 ToolInvocation 均为终态、ToolResult 存在且协议字段匹配时，才组成 `AIMessage(tool_calls) + ToolMessage[]`。
- 使用与运行时相同的 system prompt、工具 Schema、模型窗口和 reserved output 配置。
- 在调试模块内部复制当前 Token 估算与历史消息预算逻辑；不调用正式 `TokenBudget`。
- 不读取旧 Job 私有摘要、不生成新摘要、不调用模型。
- 将生成的 LangChain Message 实例立即转换为精简 DTO，不暴露 provider metadata。

响应同时返回固定的 `previewRulesVersion = context-preview-v1` 和当前 `runtimeContextRulesVersion`。二者用途不同：前者标识调试实现本身，后者帮助发现正式规则已升级但调试实现尚未同步。该接口明确标记 `debugOnly = true`，不作为模型调用审计凭据。

服务执行流程：

1. 读取 Session、Jobs、Messages、ToolInvocations。
2. 拒绝存在活动 Job 的 Session。
3. 在调试模块内部执行消息分组、筛选、工具配对、预算选择和 LangChain 格式化。
4. 再次读取 Jobs；如果读取期间创建了活动 Job，则丢弃结果并返回 409。
5. 将 LangChain Message List 转换为稳定、精简的 JSON DTO。

该方案有意接受调试实现与正式 Context 将来发生漂移的可能性，以换取核心运行时代码零污染。版本字段和独立测试用于暴露这种漂移，而不是让正式运行时依赖调试模块。

## 前端交互

在 Session 顶部操作区增加 `{}` Context 按钮：

- 没有选中 Session 时禁用。
- 存在活动 Job 时禁用，提示 `Job 完成后可查看 Context`。
- 点击后请求 Context Preview 接口并打开模态弹窗。
- 弹窗展示格式化 JSON，使用等宽字体并允许横向、纵向滚动。
- 提供 `Copy JSON`、重新请求和关闭操作。
- 展示 loading、接口错误与复制成功状态。
- Session 切换或删除后关闭弹窗并清空旧快照，避免把旧数据误认为当前 Session。
- JSON 保持后端响应原貌，不在浏览器二次拼装 LangChain Message List。

## 数据流

```text
Context button
  -> GET /sessions/:sessionId/context-preview
  -> server/debug/ContextPreviewService
  -> AgentStore reads
  -> copied debug-only context assembly
  -> LangChain BaseMessage[]
  -> compact ContextPreviewV1 DTO
  -> JSON dialog
```

## 测试范围

### 服务端

- 完成态 Session 返回 system/human/ai/tool 消息及匹配的 ToolCall/ToolResult。
- Plan、全部 StepOutput、PlanFinal 按 rowId 顺序出现在预览中。
- `internal`、`progress` 和不完整历史 ToolCall 不出现在预览中。
- 返回 `previewRulesVersion`、`runtimeContextRulesVersion` 和 `debugOnly`。
- 活动 Job 返回 409。
- Session 不存在返回 404。
- 接口不创建 Job、Message、Summary 或 ModelCall。
- `src/context/` 和正式 `job-execution.service.ts` 不发生任何改动。

### 前端

- API Client 请求路径与 DTO 类型正确。
- 活动 Job 时按钮禁用。
- 成功后展示格式化 JSON。
- 错误、刷新、复制与关闭状态正确。
- 切换 Session 后旧快照被清空。

## 非目标

- 不展示尚未发送的草稿。
- 不允许编辑消息或重新执行 Context。
- 不生成持久化快照表。
- 不通过 SSE 推送预览。
- 不暴露模型供应商私有 metadata。
- 不保证在必须执行模型压缩的超长 Session 中预览结果与最终下一轮模型输入逐字相同；接口会明确返回 `compressionRecommended`。
