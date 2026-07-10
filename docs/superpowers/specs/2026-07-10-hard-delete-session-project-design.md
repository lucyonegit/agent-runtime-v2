# Session 与 Code Project 硬删除接口设计

## 1. 目标

为 Agent Runtime 新增两个 RESTful 硬删除接口：

```http
DELETE /sessions/:sessionId
DELETE /sessions/:sessionId/projects/:projectId
```

删除操作同时处理 PostgreSQL/File Store 中的 canonical records 和本地 `.agent-sandbox` 数据。任何 active task 存在时拒绝删除，防止运行中的 Agent 在资源被移除后继续写入。

## 2. 删除语义

### 2.1 删除 Code Project

删除内容：

- `agent_code_projects` 中指定 project 记录。
- `.agent-sandbox/code-projects/{projectId}` 整个目录。

保留内容：

- 所属 session。
- 该 project 已产生的 `agent_tasks`。
- 该 project 已产生的 `agent_messages`、tool calls/results、context builds。
- 会话 UI 历史仍可查看，但 project 不再出现在可继续运行的 code project 列表中。

约束：

- project 必须属于 URL 中的 session，否则返回 `404`。
- project 关联的 code task 处于 `created/running/waiting_user_input/resuming` 时返回 `409`。
- sandbox 目录不存在时仍视为删除成功。

### 2.2 删除 Session

删除内容：

- `agent_sessions` 主记录。
- 通过 PostgreSQL `ON DELETE CASCADE` 删除关联 tasks、messages、input requests、context snapshots、context builds、token states、code projects。
- `.agent-sandbox/sessions/{sessionId}`。
- 该 session 关联的所有 `.agent-sandbox/code-projects/{projectId}`。
- 关闭并移除该 session 对应的 SSE subject。

约束：

- session 内任何 task 处于 `created/running/waiting_user_input/resuming` 时返回 `409`。
- session 不存在时返回 `404`。

## 3. API 契约

### 3.1 删除 Project

```http
DELETE /sessions/session_1/projects/project_1
```

成功：

```http
HTTP/1.1 204 No Content
```

资源不存在或不属于该 session：

```json
{
  "statusCode": 404,
  "message": "Code project not found: project_1"
}
```

存在 active code task：

```json
{
  "statusCode": 409,
  "message": "Code project has active tasks: project_1"
}
```

### 3.2 删除 Session

```http
DELETE /sessions/session_1
```

成功返回 `204 No Content`。不存在返回 `404`。存在 active task 返回：

```json
{
  "statusCode": 409,
  "message": "Session has active tasks: session_1"
}
```

## 4. Store 契约

`AgentSessionStore` 新增：

```ts
deleteSession(sessionId: string): Promise<AgentSession>;

deleteCodeProject(input: {
  sessionId: string;
  projectId: string;
}): Promise<AgentCodeProject>;
```

返回被删除对象是为了让 Service 在数据库记录消失后仍能确定 sandbox 目录和关联关系。

### 4.1 PostgreSQL 实现

`deleteSession()` 使用事务：

1. `SELECT ... FROM agent_sessions WHERE id = $1 FOR UPDATE`。
2. 不存在则抛出 `Session not found`。
3. 查询该 session 是否存在 active task。
4. 有 active task 则回滚并抛出冲突错误。
5. `DELETE FROM agent_sessions WHERE id = $1 RETURNING *`。
6. 提交事务。

`deleteCodeProject()` 使用事务：

1. 按 `id + session_id` 查询并锁定 project。
2. 不存在则抛出 `Code project not found`。
3. 查询 `agent_tasks` 中 `kind = 'code'`、`metadata->>'projectId' = projectId` 的 active task。
4. 有 active task则回滚并抛出冲突错误。
5. 删除 project 并返回删除前记录。
6. 提交事务。

删除 session 时，Service 必须在调用 `deleteSession()` 之前通过 `listCodeProjects(sessionId)` 保存 project IDs，供提交后清理 sandbox。

### 4.2 File Store 实现

- `deleteSession()` 检查 tasks 后递归删除该 session 数据目录。
- `deleteCodeProject()` 检查所有 session tasks 后，从全局 code-project JSONL 中过滤目标记录并重写文件。
- File Store 与 PostgreSQL 使用相同的不存在/冲突错误文本。

## 5. Sandbox 清理

新增两个不会接受任意路径的删除函数：

```ts
removeSessionSandbox({ sandboxRoot, sessionId }): Promise<void>;
removeCodeProjectSandbox({ sandboxRoot, projectId }): Promise<void>;
```

实现要求：

- 复用 `createSandbox()` 与 `createCodeProjectSandbox()` 的 ID 校验。
- 只根据校验后的 ID 在固定 root 下拼接目录。
- 使用 `rm(path, { recursive: true, force: true })`。
- 不允许 controller/service 直接接收或删除用户传入的绝对路径。
- 目录不存在不报错。

执行顺序固定为：

1. 预读取 project IDs。
2. Store 在事务中校验并删除 canonical records。
3. Service 删除对应 sandbox。
4. Session 删除成功后关闭 SSE subject。

数据库是 canonical source，因此先完成数据库硬删除，再清理派生的本地文件。若文件系统清理失败，接口返回 `500` 并记录明确错误；数据库不会恢复已删除记录。当前单机实现不新增 outbox 或后台清理表。

## 6. HTTP 层职责

`SessionsController` 新增：

```ts
@Delete(':sessionId')
@HttpCode(HttpStatus.NO_CONTENT)
deleteSession(@Param('sessionId') sessionId: string): Promise<void>;
```

新增 `CodeProjectsController` 或在 `SessionsController` 内增加嵌套路由。为保持资源边界清楚，采用独立 controller：

```ts
@Controller('sessions/:sessionId/projects')
export class CodeProjectsController {
  @Delete(':projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteProject(...): Promise<void>;
}
```

`AgentRuntimeService` 负责：

- 调用 Store 删除方法。
- 把 Store 的 not found 错误映射为 `NotFoundException`。
- 把 active task 错误映射为 `ConflictException`。
- 调用 sandbox 删除函数。
- session 删除后调用 `SseEventBus.close(sessionId)`。

Controller 不直接操作数据库或文件系统。

## 7. SSE 生命周期

`SseEventBus` 新增：

```ts
close(sessionId: string): void {
  const subject = this.subjects.get(sessionId);
  subject?.complete();
  this.subjects.delete(sessionId);
}
```

删除 project 不关闭 session SSE；删除 session 才关闭。

## 8. 并发与一致性

- PostgreSQL 删除检查与 DELETE 位于同一事务中。
- session row/project row 使用 `FOR UPDATE`，避免两个删除请求同时成功。
- active task 状态集合固定为：`created/running/waiting_user_input/resuming`。
- 已完成、失败和取消的 task 不阻止删除。
- 同一个资源的第二次 DELETE 返回 `404`，不伪装为成功。
- 当前系统不提供强制删除 active task 的参数。

## 9. 测试范围

必须覆盖：

1. File Store 删除 project 后，其他 projects 与历史 session messages 保留。
2. File Store 删除 session 后，session 数据目录消失。
3. PostgreSQL 删除 project 后，session/tasks/messages 保留。
4. PostgreSQL 删除 session 后，所有 session 关联表记录级联清空。
5. active task 阻止 project 删除并返回冲突。
6. active task 阻止 session 删除并返回冲突。
7. project 不属于 session 时返回 `404`。
8. sandbox 删除函数拒绝非法 ID 和路径穿越。
9. sandbox 目录不存在时删除成功。
10. REST 成功响应为 `204`，无响应 body。
11. session 删除后 SSE observable complete。
12. project 删除不关闭 session SSE。
13. 现有 100 个测试继续通过。

## 10. 前端 UI 接入

前端项目：`/Users/hanljjie/Desktop/Agent/agent-runtime-v2-web`。

### 10.1 API Client

`AgentApi` 新增：

```ts
deleteSession(sessionId: string): Promise<void>;
deleteCodeProject(sessionId: string, projectId: string): Promise<void>;
```

通用 `request<T>()` 必须识别 `204 No Content`，不能继续调用 `response.json()`：

```ts
if (response.status === 204) {
  return undefined as T;
}
```

新增携带 HTTP status 的 `AgentApiError`，让 UI 可以区分：

- `404`：资源已经不存在，刷新列表或当前 view。
- `409`：资源仍有 active task，确认弹窗保持打开并展示冲突信息。
- 其他错误：保留弹窗并展示服务端 message。

### 10.2 Hook 状态

`useAgentSession()` 新增：

```ts
deleteSession(sessionId: string): Promise<void>;
deleteCodeProject(projectId: string): Promise<void>;
deletingResource?: { type: 'session' | 'project'; id: string };
```

删除当前 session 成功后：

1. 从本地 `sessions` 中移除目标。
2. 选择同 workspace 中删除项之后的下一条；没有下一条则选择前一条。
3. 没有剩余 session 时清空 reducer view 和 `sessionId`。
4. 当前 session 变化会触发现有 SSE effect 清理旧 EventSource。

删除非当前 session 时保持当前会话不变。

删除 project 成功后：

1. 当前 session 保持不变。
2. 调用 `reload()` 获取最新 view。
3. `codeProjects` 中目标消失，历史 task/message 继续展示。

删除函数把错误重新抛给确认弹窗处理，不能只写入全局 error banner 后吞掉异常。

### 10.3 会话删除入口

`SessionSidebar` 中每个 session card：

- hover/focus 时显示 `MoreHorizontal` icon button。
- 点击 icon button 必须 `stopPropagation()`，不能切换会话。
- 弹出小型操作菜单，菜单中使用 `Trash2` 图标和“删除会话”。
- 菜单按钮有 `aria-label` 和 `title`。
- 删除中的目标显示 `LoaderCircle`，并禁止重复操作。
- 菜单不常驻显示，保持当前侧栏密度。

### 10.4 Project 删除入口

`WorkspacePanel` 的 Code Project 卡片标题区：

- active project 存在时显示 `MoreHorizontal` 操作按钮。
- 菜单提供“删除项目”。
- 删除 project 不关闭 Inspector，也不切换 session。
- 删除成功后 Code Project 卡片进入 empty state，历史 code changes 仍可查看。

### 10.5 确认弹窗

新增共享组件：

```text
src/components/ConfirmDeleteDialog.tsx
```

`SessionShell` 持有统一目标状态：

```ts
type DeleteTarget =
  | { type: 'session'; session: AgentSession }
  | { type: 'project'; project: AgentCodeProject };
```

弹窗内容：

- Session 标题：“永久删除此会话？”
- Session 说明：会删除会话、任务、消息、上下文记录以及关联项目文件。
- Project 标题：“永久删除此项目？”
- Project 说明：会删除项目记录和代码目录，但保留会话中的历史消息。
- 次操作按钮：“取消”。
- 危险主操作按钮：“永久删除”。
- 删除中显示 `LoaderCircle`，关闭按钮和提交按钮按状态禁用。
- `409`/其他服务端错误显示在弹窗内，不自动关闭。
- 成功后关闭弹窗。

弹窗使用现有 UI 色彩和 8px 以内圆角，不增加新的视觉主题，不使用浏览器原生 `confirm()`。

### 10.6 前端文件范围

修改：

- `src/api/agentApi.ts`
- `src/store/useAgentSession.ts`
- `src/components/SessionShell.tsx`
- `src/components/SessionSidebar.tsx`
- `src/components/WorkspacePanel.tsx`
- `src/styles.css` 或 `src/design-v2.css`

新增：

- `src/components/ConfirmDeleteDialog.tsx`

### 10.7 前端验证

必须覆盖以下手工/构建验证：

1. `npm run build` 通过。
2. 删除非当前 session 后当前会话不跳转。
3. 删除当前 session 后选择相邻 session。
4. 删除最后一个 session 后显示空状态，且不请求不存在的 session view。
5. 删除 project 后历史消息保留，Project 卡片变为空状态。
6. `409` 在弹窗内显示，弹窗不关闭。
7. `204` 不触发 JSON parse error。
8. 菜单点击不触发 session card 的选择事件。
9. 桌面宽度和窄屏下弹窗不溢出。
10. 键盘可聚焦菜单、取消和永久删除按钮。

## 11. 不在本次范围

- 软删除或回收站 UI。
- 强制取消 active task 后再删除。
- 删除 task/message 单条记录。
- 分布式文件存储清理。
- 删除 outbox、重试队列或后台清理任务。
- 回收站、批量删除和撤销删除。

## 12. 验收标准

- 两个 DELETE 接口均可通过 NestJS 调用。
- PostgreSQL 和 File Store 行为一致。
- 删除 session 不留下任何数据库关联记录或本地 session/project sandbox。
- 删除 project 不影响 session 与历史消息。
- active task 删除请求稳定返回 `409`。
- 不存在资源稳定返回 `404`。
- 前端会话菜单和 Code Project 菜单均可发起删除。
- 确认弹窗正确处理 loading、`404`、`409` 和成功状态。
- 删除当前 session 后不会继续请求已删除 session 的 view/SSE。
- 删除 project 后当前会话和历史消息保持不变。
- 全量 test/typecheck/build 通过。
