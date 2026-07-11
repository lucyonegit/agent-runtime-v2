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
  contextRulesVersion: string;
  systemPromptVersion: string;
  estimatedInputTokens: number;
  compressionRecommended: boolean;
  limits: {
    maxContextTokens: number;
    reservedOutputTokens: number;
  };
  manifest: AgentContextInputManifest;
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
- 历史中存在不完整的旧 ToolCall：共享构建函数不把不完整交换放进历史 Message List。

### 共享纯函数

把当前 `ContextBuilder` 类改为无状态纯函数 `buildContext(input)`。数据库读取、摘要持久化、模型调用、时钟和 HTTP DTO 序列化全部留在函数外部；相同输入必须得到相同的 LangChain Message List、manifest、Token 估算和压缩建议。

函数使用显式的业务范围，而不是通过 `currentJobId` 是否为空判断“正式模式”或“预览模式”：

```ts
type ContextScope =
  | { kind: 'session_history' }
  | { kind: 'job'; jobId: string; originalGoal: string }
  | { kind: 'step_run'; jobId: string; stepRunId: string; originalGoal: string };

interface BuildContextInput {
  purpose: ContextPurpose;
  scope: ContextScope;
  systemPrompt: string;
  systemPromptVersion: string;
  currentInstruction?: string;
  stableContext?: string;
  messages: AgentMessage[];
  invocations: AgentToolInvocation[];
  summaries?: Array<{ id: string; summary: string; sourceRowIdEnd?: number }>;
  model: {
    provider: string;
    name: string;
    maxContextTokens: number;
    reservedOutputTokens: number;
  };
  toolSchemas?: StructuredToolInterface[];
  newCompressibleMessageCount?: number;
  compressionMessageThreshold?: number;
  compressionSourcePurpose?: Exclude<ContextPurpose, 'context_compression'>;
}

function buildContext(input: BuildContextInput): BuiltContext;
```

两个调用场景：

- 正式会话：Job 使用 `scope = { kind: 'job', jobId, originalGoal }`；StepRun 使用 `scope = { kind: 'step_run', jobId, stepRunId, originalGoal }`。
- Context Preview：使用 `purpose = job_execution` 与 `scope = { kind: 'session_history' }`，表示所有已落库内容均为历史基础上下文，不包含尚未发生的新 UserMessage。

`buildContext()` 内部唯一实现消息分组、内部消息和 `progress` 过滤、完整 ToolCall/ToolResult 配对、Plan/StepOutput 保留、摘要覆盖、TokenBudget 与 LangChain 格式化。Preview Service 只负责读库、活动 Job 校验以及将 `BaseMessage[]` 精简为 JSON DTO。

服务执行流程：

1. 读取 Session、Jobs、Messages、ToolInvocations。
2. 拒绝存在活动 Job 的 Session。
3. 使用运行时相同的 system prompt、工具 Schema、模型窗口配置，调用 `buildContext({ purpose: 'job_execution', scope: { kind: 'session_history' }, ... })`。
4. 再次读取 Jobs；如果读取期间创建了活动 Job，则丢弃结果并返回 409。
5. 将 LangChain Message List 转换为稳定、精简的 JSON DTO。

接口仍标记 `debugOnly = true`，但消息选择与正式运行时共享同一个 `contextRulesVersion` 和纯函数，不维护第二套近似规则。

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
  -> ContextPreviewService
  -> AgentStore reads
  -> buildContext(session_history)
  -> LangChain BaseMessage[]
  -> compact ContextPreviewV1 DTO
  -> JSON dialog
```

## 测试范围

### 服务端

- 完成态 Session 返回 system/human/ai/tool 消息及匹配的 ToolCall/ToolResult。
- 同一输入重复调用 `buildContext()` 得到深度相等的结果，且输入对象不被修改。
- 正式 Job、StepRun 和 Preview 均调用同一个 `buildContext()`。
- Plan、全部 StepOutput、PlanFinal 按 rowId 顺序出现在预览中。
- `internal`、`progress` 和不完整历史 ToolCall 不出现在预览中。
- 返回正式 `contextRulesVersion` 和 `debugOnly`。
- 活动 Job 返回 409。
- Session 不存在返回 404。
- 接口不创建 Job、Message、Summary 或 ModelCall。

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
