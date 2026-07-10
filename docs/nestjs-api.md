# NestJS API 说明

`src/server/http` 把编排层暴露为可组合的 NestJS module。

## 模块注册

```ts
AgentServerModule.register({
  store,
  contextBuilder,
  react,
  planner,
  plannerStepReact,
  code,
})
```

应用层把已配置的 `PlannerCore`、普通 `ReactCore`、Planner-step `ReactCore` 和 Code `ReactCore` 注入 module。普通 Agent 的两个兼容 REST 入口最终都进入同一个 `PlannerReactAgent`。

## REST

- `GET /sessions/:sessionId/view`
- `GET /sessions/:sessionId/events`
- `POST /sessions/:sessionId/react/runs`
- `POST /sessions/:sessionId/planner-react/runs`
- `POST /sessions/:sessionId/input-requests/:requestId/answer`

## SSE

`GET /sessions/:sessionId/events` 流式发送 `AgentSessionPatch`。SSE event name 使用 `patch.type`，payload 是完整 patch 对象。

## 存储

PostgreSQL 持久化使用 `PostgresSessionStore`：

```ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await initializePostgresSessionStoreSchema(pool);
const store = new PostgresSessionStore(pool);
```
