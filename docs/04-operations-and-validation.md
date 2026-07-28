# 运行、重置与验证

## 1. 配置

默认配置位于 `src/config/runtime.json`，环境变量用于数据库 URL、模型密钥等部署覆盖。Context 只有 `keepRecentInputTokens/maxToolResultTokens/summaryMaxTokens` 三个策略参数；模型窗口与输入/输出限制由 model profile 解析。

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
- `POST /tasks/:taskId/retry`
- `POST /tasks/:taskId/continue-as-new`
- `POST /tasks/:taskId/resume`
- `POST /user-input-requests/:requestId/answer`
- `GET /sessions/:sessionId/events`
- `GET /sessions/:sessionId/context-preview`

Electron IPC 使用对应的 `task.create/task.cancel/task.retry/task.resume` 命令，不暴露 HTTP 给 Renderer。

## 4. 验证矩阵

```bash
npm run typecheck
npm test
npm run test:postgres
npm run build
```

PostgreSQL 集成测试覆盖：

- Task/TaskRun/ToolCall/ToolRun 的创建与状态流转。
- ToolMessage 作为唯一工具结果事实。
- Task 终态事务清理 ActivePlan。
- Retry 创建新 Task 且不污染旧执行历史。
- HITL 回答和过期分别创建正确 trigger 的 TaskRun。
- 崩溃恢复时安全工具可重跑，有副作用工具进入 `outcome_unknown`。

