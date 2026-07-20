# HTTP、运行与验收

## 1. HTTP 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/sessions` | 创建 Session |
| `GET` | `/sessions` | 列出 Session |
| `DELETE` | `/sessions/:sessionId` | 删除 Session 及 workspace |
| `POST` | `/sessions/:sessionId/jobs` | 创建并异步执行 Job |
| `POST` | `/jobs/:jobId/cancel` | 按 Job version 取消 |
| `POST` | `/jobs/:jobId/retry` | 从失败 Job 创建新 Job |
| `POST` | `/user-input-requests/:id/answer` | 回答 HITL 并恢复 Job |
| `GET` | `/sessions/:sessionId/view` | 加载权威 SessionView |
| `GET` | `/sessions/:sessionId/events` | 订阅 SSE |
| `GET` | `/sessions/:sessionId/context-preview` | 预览下一轮 conversation Context |
| `GET` | `/jobs/:jobId/context-preview` | 预览 Job Context |
| `GET` | `/model-calls/:id/context` | 读取历史调用的精确输入 |

DELETE 请求不发送 JSON body；客户端只有在 body 存在时才设置 `content-type: application/json`。

## 2. 环境变量

Server 入口使用 `dotenv/config`。主要变量：

```text
DATABASE_URL=postgresql://...
DASHSCOPE_API_KEY=...
OPENAI_MODEL=qwen-max
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
HOST=127.0.0.1
PORT=3000
```

`.env` 必须被 Git 忽略，日志和调试接口不得输出 API Key。

## 3. Schema

正常启动只执行只读 schema guard，不自动迁移或重置。当前是破坏性 canonical schema v1，名字为 `unified-job-react-canonical`。

开发环境显式重置：

```bash
NODE_ENV=development \
ALLOW_AGENT_RUNTIME_RESET=true \
npm run schema:reset -- --confirm-agent-runtime-reset
```

脚本只删除当前 schema 内 `agent_%` 表，不处理其他业务表。

## 4. 本地运行

```bash
npm run typecheck
npm test
npm run test:postgres
npm run build
npm run serve
```

前端：

```bash
cd ../agent-runtime-v2-web
npm test
npm run build
```

## 5. 端到端验收

至少验证：

1. Direct Job 不创建 Plan，最终产生 `assistant_message/final`。
2. 复杂 Job 创建 Plan，普通工具与 update_plan 交替执行，所有步骤终态后 Job completed。
3. 混合 exclusive tool batch 被撤回并纠正，不产生 ToolInvocation。
4. Plan active 时 premature final 被 `message.discarded` 撤回，随后可继续 update_plan。
5. HITL 等待、回答和恢复后使用同一 Job。
6. Retry 不复制原 HumanMessage；有新说明时只新增一条。
7. SessionView 的 flat timeline 与 SSE reducer 最终相同。
8. ModelCall Context 返回 `verification.status = exact` 且消息数量与 `input_messages` 一致。
9. Session 删除返回 204，且不发送空 JSON body。

## 6. 当前边界

- Runtime 暂不支持模型流式生成 tool-call JSON 参数时实时展示文件 content delta；工具调用只有在参数组装完成后才能持久化并执行。
- Session Context 压缩保留业务摘要和当前 Job bundle；不是 provider checkpoint。
- Plan 是用户可见的 durable progress，不是 DAG 调度器。需要真正并行/分布式 DAG 时应新增独立执行模型，而不是重新把 StepRun 塞回 ReAct 内部。
