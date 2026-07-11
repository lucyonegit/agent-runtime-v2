# 会话 Context Preview 调试入口设计

## 目标

为每个 Session 提供一个只读调试入口，展示“如果此刻开始下一轮对话，已经落库的历史会形成怎样的 LangChain Message List”。该能力用于核对 Context 过滤、消息顺序、Plan/StepOutput、ToolCall/ToolResult 配对、摘要与 TokenBudget，不创建 Job、不写数据库、不调用模型。

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
- 历史中存在不完整的旧 ToolCall：沿用 `MessageGroupBuilder` 行为，不把不完整交换放进 Message List；当前没有活动 Job，因此不会把该历史异常误判为正在执行的协议消息。

### Context 构建

将当前有实例状态的 `ContextBuilder` 收敛为导出的纯函数：

```ts
function buildContext(input: BuildContextInput): BuiltContext;

interface BuildContextInput {
  purpose: ContextPurpose;
  currentJobId?: string;
  currentStepRunId?: string;
  originalGoal?: string;
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
```

`buildContext()` 不读取数据库、不写摘要、不调用模型、不依赖时钟，也不保存可变实例状态。相同输入必须得到相同的 LangChain Message List、manifest、Token 估算和压缩建议。

正常 Job 执行和 Context Preview 都调用同一个 `buildContext()`：

- 正常 Job：`purpose = job_execution`，传入真实 `currentJobId`、`originalGoal` 和已经落库的当前 `UserMessage`；当前用户目标保持 `mustKeep`。
- 调试快照：同样使用 `purpose = job_execution`，但不传 `currentJobId` 和 `originalGoal`；这表示当前没有尚未发生的新一轮，所有已落库消息都是历史消息。
- `step_execution`、`plan_final`、`code_execution` 必须传入 `currentJobId`；`step_execution` 还必须传入 `currentStepRunId`。纯函数对缺失的必需范围参数直接抛出输入错误。

调试接口可以使用薄的 `ContextPreviewService` 负责读取数据、活动 Job 校验和 DTO 序列化，但它不能拥有另一套 Context 选择规则。

服务执行流程：

1. 读取 Session、Jobs、Messages、ToolInvocations。
2. 拒绝存在活动 Job 的 Session。
3. 构造与正常运行相同的 `BuildContextInput`，但不设置尚未发生的 `currentJobId`、`originalGoal` 或 UserMessage。
4. 调用纯函数 `buildContext()`，固定使用正常对话的 `purpose = job_execution`，从而应用正式的消息分组、内部消息过滤、`progress` 过滤、TokenBudget、LangChain 格式化和上下文规则版本。
5. 使用与运行时一致的 system prompt、system prompt version、模型窗口配置和工具 Schema。
6. 不加载旧 Job 私有摘要，也不触发模型压缩。`compressionRecommended = true` 时只在结果中提示：真实下一轮可能先生成新 Job 所属摘要，再得到最终模型输入。
7. 将 `BaseMessage[]` 转换为稳定、精简的 JSON DTO。

该设计不在前端或 Preview Service 中重写 Context 规则，因此服务端预览与运行时共享同一个纯函数，而不是仅复用一个类名或近似的 `conversation` 分支。

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
  -> buildContext(input)
  -> LangChain BaseMessage[]
  -> compact ContextPreviewV1 DTO
  -> JSON dialog
```

## 测试范围

### 服务端

- 完成态 Session 返回 system/human/ai/tool 消息及匹配的 ToolCall/ToolResult。
- 相同 `BuildContextInput` 多次调用产生深度相等的结果，且不会改变输入数组或消息对象。
- 正常 Job Context 与 Preview Context 都通过 `buildContext()` 的 `job_execution` 分支构建。
- Plan、全部 StepOutput、PlanFinal 按 rowId 顺序出现在预览中。
- `internal`、`progress` 和不完整历史 ToolCall 不出现在预览中。
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
