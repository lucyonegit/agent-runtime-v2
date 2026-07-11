# LangChain-native Agent Runtime 设计

## 1. 硬约束

Agent Runtime 的模型协议必须以 LangChain 为唯一桥梁：模型输入输出、消息、tool call、stream chunk、tool schema、tool invoke 和 provider 实现不得再定义平行协议。

业务运行时职责继续由本项目负责：Session、Job、Plan、PlanStep、StepRun、lease、attempt fencing、PostgreSQL 事务、HITL、Context purpose、SSE 和 View 不属于 LangChain 的职责。

## 2. 模型边界

- Provider factory 返回 LangChain `BaseChatModel`。
- AgentLoop 消费绑定工具后的 LangChain `Runnable<BaseLanguageModelInput, AIMessageChunk>`。
- 非流式调用直接消费 `AIMessage`/`AIMessageChunk` 的 `text`、`tool_calls`、`invalid_tool_calls` 和 `usage_metadata`。
- 流式调用累加 `AIMessageChunk.concat()`；不再自行拼接 tool-call JSON。
- ModelCall 审计实现为 LangChain `Runnable` decorator，输入输出保持 LangChain 类型。
- DashScope 使用 LangChain `ChatOpenAI` 和 OpenAI-compatible base URL，不实现 DashScope HTTP client。

## 3. 消息边界

- 模型上下文只使用 `SystemMessage`、`HumanMessage`、`AIMessage`、`AIMessageChunk`、`ToolMessage`、`BaseMessage`。
- JavaScript LangChain 的用户消息类型是 `HumanMessage`。
- PostgreSQL `agent_messages` 保存稳定的可序列化投影；`ContextFormatter` 是存储实体到 LangChain Message 的唯一恢复边界。
- 持久化 tool call 类型直接基于 LangChain `ToolCall`，只额外收紧数据库必需的 `id`。
- provider metadata、content blocks 和 reasoning 不在模型调用中间层降级为自定义 response DTO。

## 4. 工具边界

- 工具定义统一为 LangChain `StructuredToolInterface`，默认工具使用 `DynamicStructuredTool`。
- AgentLoop 将同一组 StructuredTool 同时交给 `bindTools()` 和 ToolExecutor。
- ToolExecutor 在外部副作用前完成 ToolInvocation claim，然后调用 `tool.invoke(ToolCall, RunnableConfig)`。
- `ToolMessage.tool_call_id` 必须匹配 `AIMessage.tool_calls[].id`。
- side-effect level、敏感参数路径等持久化策略放在 RuntimeTool metadata 中，不复制 LangChain schema/name/description。
- `request_user_input` 仍是 LangChain tool；它通过 `ToolMessage.artifact` 返回 HITL sentinel，Runtime 将其转换为 waiting 状态，用户回答后才提交最终 tool result。

## 5. 删除项

- 删除 `AgentLoopModelPort`、`ModelRequest`、`ModelResponse`、`ModelStreamChunk`。
- 删除自定义 `AgentToolDefinition`。
- 删除 `ToolCallAssembler`，改用 `AIMessageChunk.concat()` 以及 LangChain 的 `invalid_tool_calls`。
- 删除包装并拆解 `AIMessage` 的 `OpenAIModelPort`，改成返回 `ChatOpenAI` 的 provider factory。

## 6. dotenv 与 DashScope

- 使用 `dotenv/config` 自动加载项目根目录 `.env`。
- DashScope 优先读取 `DASHSCOPE_API_KEY`，默认 base URL 为 `https://dashscope.aliyuncs.com/compatible-mode/v1`，默认模型为 `qwen-plus`。
- 保留 `OPENAI_API_KEY` fallback。
- `.env` 被 Git 忽略，测试和日志不得输出密钥。

## 7. 验收

- 单元测试直接断言输出为 LangChain Message/Chunk/ToolMessage，而不是自定义 DTO。
- streaming tool call 由 LangChain chunk concat 得到完整 ToolCall。
- 普通工具通过 `StructuredToolInterface.invoke()` 执行。
- HITL tool 通过 LangChain ToolMessage artifact 进入 waiting/resume。
- Direct、两步 Planned、ModelCall audit、Context compression、PostgreSQL 并发测试全部通过。
- 使用真实 PostgreSQL、dotenv 和 DashScope 启动 server，Job 达到 completed、waiting_user_input 或明确 failed 终态。
