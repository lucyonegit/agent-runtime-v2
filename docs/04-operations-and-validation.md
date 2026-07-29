# 运行、重置与验证

## 1. 配置

默认配置位于 `src/config/runtime.json`，环境变量用于数据库 URL、模型密钥等部署覆盖。Context 只有 `keepRecentInputTokens/maxToolResultTokens/summaryMaxTokens` 三个策略参数；模型窗口与输入/输出限制由 model profile 解析。

standalone HTTP 默认 fail closed：启动前必须设置至少 32 字符的 `AGENT_SERVER_AUTH_TOKEN`，Web 使用相同的 `VITE_AGENT_API_TOKEN`。所有普通请求和 SSE 都发送 `Authorization: Bearer <token>`。CORS 只允许 `runtime.json` 中列出的显式 Origin，默认是本机 5174 开发端口；不要把带有构建期 token 的 Web 静态包公开部署。

Context Preview 可能包含敏感答案、工具参数和模型输入，三个 Debug Context HTTP 路由默认不注册。仅在受控的本地排障环境中设置 `AGENT_SERVER_ENABLE_DEBUG_ENDPOINTS=true`；Electron 内部 IPC 的 Context Preview 不受这个 HTTP 开关影响。

standalone HTTP 默认 capability 只有 `artifacts,filesystem`，因此不能调用宿主 Shell、启动长驻进程或访问网络。需要时通过完整列表显式设置，例如 `AGENT_SERVER_TOOL_CAPABILITIES=artifacts,filesystem,shell,managedProcesses,browser`；全局 `tools.enabled` 仍是上限，HTTP capability 不能重新开启全局已关闭的工具。未授权 `managedProcesses` 时，对应 HTTP 管理路由也不注册。Electron 受控 IPC 不套用这层 HTTP capability 收缩。

Shell 和 Managed Process 子进程不再继承完整 `process.env`，只继承 `tools.environment.inheritedKeys` 中的非敏感键；默认列表仅包含 PATH、用户目录、临时目录、locale 和终端基础信息。部署可用 `AGENT_TOOL_INHERITED_ENV_KEYS` 覆盖完整 allowlist，但 API key、token、credential、password、认证 socket 及 Runtime/HTTP 内部变量会被拒绝。需要凭据的工具应后续接入按工具、按 Task 注入的 secret broker，不应重新放宽为宿主环境 blocklist。

## 2. 破坏式重建数据库

开发环境执行：

```bash
NODE_ENV=development npm run schema:reset -- --confirm-agent-runtime-reset
```

脚本会：

1. 读取当前 schema 下全部 `agent_*` 表。
2. 在事务内删除这些表。
3. 执行唯一 `schema.ts` 创建目标结构。
4. 提交事务。

服务启动只校验“预期表全部存在且没有额外旧表”，不会隐式迁移或自动重置。

## 3. HTTP 接口

- `POST /sessions`
- `GET /sessions`
- `GET /sessions/:sessionId/view`
- `DELETE /sessions/:sessionId`
- `POST /sessions/:sessionId/tasks`
- `POST /tasks/:taskId/cancel`
- `POST /user-input-requests/:requestId/answer`
- `GET /sessions/:sessionId/events`

以下 Debug Context 路由仅在显式启用后存在：

- `GET /sessions/:sessionId/context-preview`
- `GET /tasks/:taskId/context-preview`
- `GET /model-calls/:modelCallId/context`

Runtime 不暴露 retry、continue-as-new 或通用 resume 命令。Task 失败/取消后由用户新消息创建新 Task；`answer` 是唯一可以继续原 Task 的入口。

## 4. 验证矩阵

```bash
npm run typecheck
npm test
npm run test:postgres
npm run build
```

PostgreSQL 集成测试覆盖：

- Task、TaskRun 和 ToolCall 的创建、租约 fence 与状态流转。
- ToolMessage 作为唯一工具结果事实。
- Task 终态事务清理 ActivePlan。
- 普通 HITL 回答创建 `user_input_answered` TaskRun，过期则安全终止。
- 崩溃对账不自动重跑：只读工具失败，有副作用工具进入 `outcome_unknown` 并请求用户确认。
- 未知副作用的三种回答、超时和原始结果不可恢复语义。
