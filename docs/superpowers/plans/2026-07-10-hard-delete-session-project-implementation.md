# Session 与 Code Project 硬删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Agent Runtime 前后端实现 Session 与 Code Project 的安全硬删除，包括数据库级联、sandbox 清理、active task 冲突保护和 UI 确认交互。

**Architecture:** `AgentSessionStore` 提供跨 Postgres/File 的删除原语，`AgentRuntimeService` 负责数据库记录与 sandbox/SSE 生命周期协调，Nest controller 暴露两个 `204` DELETE 接口。React 前端通过共享 API client 与 Hook 收敛删除状态，在 SessionSidebar 和 Code Project 面板提供 hover 菜单与统一确认弹窗。

**Tech Stack:** TypeScript、NestJS、PostgreSQL、React 19、Vite、Lucide React、Vitest、Node.js `fs/promises`。

---

### Task 1: Store 硬删除原语

**Files:**

- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/src/storage/session-store.ts`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/src/storage/file-session-store.ts`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/src/storage/postgres-session-store.ts`
- Test: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/tests/store.test.ts`
- Test: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/tests/postgres-store.test.ts`

- [ ] **Step 1: 写 File Store 删除失败测试**

```ts
await expect(store.deleteCodeProject({ sessionId: 'session_1', projectId: 'project_1' }))
  .resolves.toMatchObject({ id: 'project_1' });
expect(await store.listCodeProjects('session_1')).toEqual([]);
expect(await store.listMessages('session_1')).toHaveLength(1);

await expect(store.deleteSession('session_1')).resolves.toMatchObject({ id: 'session_1' });
expect(await store.getSession('session_1')).toBeNull();
```

增加 active task、project/session 不存在、project 归属错误测试，错误文本分别固定为：

```text
Session not found: session_1
Session has active tasks: session_1
Code project not found: project_1
Code project has active tasks: project_1
```

- [ ] **Step 2: 扩展 Store 接口**

```ts
deleteSession(sessionId: string): Promise<AgentSession>;
deleteCodeProject(input: { sessionId: string; projectId: string }): Promise<AgentCodeProject>;
```

- [ ] **Step 3: 实现 File Store**

`deleteSession()` 读取 session、检查 active task 后使用 `rm(sessionDir, { recursive: true, force: true })`。`deleteCodeProject()` 从全局 JSONL 读取目标、检查 `kind === 'code' && metadata.projectId === projectId` 的 active task，然后过滤重写。

- [ ] **Step 4: 写 PostgreSQL 删除测试**

测试 project 删除保留 session/task/message；session 删除后逐表查询关联行数为 0；active task 事务回滚。

- [ ] **Step 5: 实现 PostgreSQL 事务**

```ts
const client = await this.pool.connect();
try {
  await client.query('begin');
  const session = await client.query(
    'select * from agent_sessions where id = $1 for update',
    [sessionId]
  );
  // not found / active checks
  await client.query('delete from agent_sessions where id = $1', [sessionId]);
  await client.query('commit');
  return toSession(session.rows[0]);
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  client.release();
}
```

Project 使用相同事务结构，active code task 通过 `metadata->>'projectId'` 查询。

- [ ] **Step 6: 运行 Store 测试**

Run: `npx vitest run tests/store.test.ts tests/postgres-store.test.ts`

Expected: PASS。

---

### Task 2: Sandbox 删除函数

**Files:**

- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/src/tools/sandbox.ts`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/src/code-agent/project-sandbox.ts`
- Test: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/tests/runtime-tools.test.ts`
- Test: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/tests/code-agent.test.ts`

- [ ] **Step 1: 写 sandbox 删除测试**

创建 session/project 目录和文件，调用删除函数后断言 `existsSync(root) === false`；非法 `../escape` ID 断言抛出 `Invalid ... id`；不存在目录不抛错。

- [ ] **Step 2: 实现固定 root 删除函数**

```ts
export async function removeSessionSandbox(input: { root: string; sessionId: string }): Promise<void> {
  const sandbox = createSandbox(input);
  await rm(getSandboxSessionRoot(sandbox), { recursive: true, force: true });
}

export async function removeCodeProjectSandbox(input: { sandboxRoot: string; projectId: string }): Promise<void> {
  const sandbox = createCodeProjectSandbox(input);
  await rm(getCodeProjectRoot(sandbox), { recursive: true, force: true });
}
```

将 `getCodeProjectRoot` 导出，确保删除逻辑不重复拼路径。

- [ ] **Step 3: 运行 sandbox 测试**

Run: `npx vitest run tests/runtime-tools.test.ts tests/code-agent.test.ts`

Expected: PASS。

---

### Task 3: Nest DELETE 接口与 SSE 关闭

**Files:**

- Create: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/src/server/http/controllers/code-projects.controller.ts`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/src/server/http/controllers/sessions.controller.ts`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/src/server/http/server.module.ts`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/src/server/http/agent-runtime.service.ts`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/src/server/http/sse-event-bus.ts`
- Test: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/tests/api.test.ts`

- [ ] **Step 1: 写 controller/service 失败测试**

```ts
await expect(controller.deleteSession('session_1')).resolves.toBeUndefined();
expect(service.deleteSession).toHaveBeenCalledWith('session_1');

await expect(projectsController.deleteProject('session_1', 'project_1'))
  .resolves.toBeUndefined();
expect(service.deleteCodeProject).toHaveBeenCalledWith('session_1', 'project_1');
```

增加 `SseEventBus.close()` 使 observable complete 的测试。

- [ ] **Step 2: 实现 Service 删除协调**

```ts
async deleteSession(sessionId: string): Promise<void> {
  const projects = await this.store.listCodeProjects(sessionId);
  await this.mapDeleteErrors(() => this.store.deleteSession(sessionId));
  await Promise.all([
    removeSessionSandbox({ root: this.sandboxRoot, sessionId }),
    ...projects.map(project => removeCodeProjectSandbox({
      sandboxRoot: this.sandboxRoot,
      projectId: project.id,
    })),
  ]);
  this.events.close(sessionId);
}
```

`deleteCodeProject()` 先 Store 删除，再删除 project sandbox。错误映射：`not found -> NotFoundException`，`active tasks -> ConflictException`。

- [ ] **Step 3: 新增 Controller**

使用 `@Delete`、`@HttpCode(HttpStatus.NO_CONTENT)`。将 `CodeProjectsController` 注册到 `AgentServerModule.controllers`。

- [ ] **Step 4: 运行 API 测试**

Run: `npx vitest run tests/api.test.ts && npm run typecheck`

Expected: PASS。

---

### Task 4: 前端 API Client 与 Session Hook

**Files:**

- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2-web/src/api/agentApi.ts`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2-web/src/store/useAgentSession.ts`

- [ ] **Step 1: 增加 AgentApiError 与 DELETE 方法**

```ts
export class AgentApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

deleteSession(sessionId: string) {
  return this.request<void>(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

deleteCodeProject(sessionId: string, projectId: string) {
  return this.request<void>(
    `/sessions/${encodeURIComponent(sessionId)}/projects/${encodeURIComponent(projectId)}`,
    { method: 'DELETE' }
  );
}
```

`request()` 在 `!response.ok` 时抛 `AgentApiError`，在 `status === 204` 时返回 `undefined`。

- [ ] **Step 2: 扩展 Hook 返回值**

```ts
deleteSession: (sessionId: string) => Promise<void>;
deleteCodeProject: (projectId: string) => Promise<void>;
deletingResource?: { type: 'session' | 'project'; id: string };
```

- [ ] **Step 3: 实现会话切换规则**

删除当前 session 时按原数组 index 选择后一项，否则选择前一项；删除非当前 session 保持选择；空列表时 `dispatch({ type: 'cleared' })`。

- [ ] **Step 4: 实现 Project 刷新规则**

调用 API 后 `await reload()`，不修改 sessionId。删除函数使用 `try/finally` 清理 loading，并把异常重新抛给 Dialog。

- [ ] **Step 5: 运行前端 type/build**

Run: `npm run build`

Expected: PASS。

---

### Task 5: hover 菜单与统一确认弹窗

**Files:**

- Create: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2-web/src/components/ConfirmDeleteDialog.tsx`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2-web/src/components/SessionSidebar.tsx`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2-web/src/components/WorkspacePanel.tsx`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2-web/src/components/SessionShell.tsx`
- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2-web/src/design-v2.css`

- [ ] **Step 1: 创建 ConfirmDeleteDialog**

组件 props：

```ts
interface ConfirmDeleteDialogProps {
  target?: DeleteTarget;
  loading: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}
```

使用 `Trash2/X/LoaderCircle`，`role="dialog"`、`aria-modal="true"`，成功由父层关闭，失败显示 `.delete-dialog-error`。

- [ ] **Step 2: SessionSidebar 添加 hover 菜单**

新增 `onRequestDeleteSession(session)` callback；`MoreHorizontal` button 使用 `event.stopPropagation()`；菜单项调用 callback 后关闭菜单。

- [ ] **Step 3: WorkspacePanel 添加 Project 菜单**

新增 `onRequestDeleteProject(project)` callback；仅 activeProject 存在时显示菜单；project 删除 loading 时禁用。

- [ ] **Step 4: SessionShell 收敛状态**

```ts
const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
const [deleteError, setDeleteError] = useState<string>();

async function confirmDelete() {
  try {
    if (deleteTarget?.type === 'session') await session.deleteSession(deleteTarget.session.id);
    if (deleteTarget?.type === 'project') await session.deleteCodeProject(deleteTarget.project.id);
    setDeleteTarget(undefined);
  } catch (error) {
    setDeleteError(getErrorMessage(error));
  }
}
```

- [ ] **Step 5: 添加样式**

菜单仅 hover/focus-within 可见；弹窗最大宽度 440px、移动端 `calc(100vw - 32px)`；危险操作使用现有红色系；圆角不超过 8px；loading icon 旋转。

- [ ] **Step 6: 前端 build**

Run: `npm run build`

Expected: PASS。

---

### Task 6: 全链路验证与服务重启

**Files:**

- Modify: `/Users/hanljjie/Desktop/Agent/agent-runtime-v2/docs/nestjs-api.md`
- Verify: backend/frontend build outputs

- [ ] **Step 1: 更新 API 文档**

加入两个 DELETE endpoint、204/404/409 语义和 sandbox 清理说明。

- [ ] **Step 2: 后端全量验证**

Run: `npm test && npm run typecheck && npm run build`

Expected: 全部 PASS。

- [ ] **Step 3: 前端 build**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 4: 重启 3000 服务并 smoke test**

创建临时 session/project，验证 project DELETE 与 session DELETE 都返回 204，随后 GET 返回 404；确认数据库关联行和 sandbox 路径消失。

- [ ] **Step 5: Git 限制**

当前两个 runtime 目录均不在可用 Git worktree 中，无法执行逐任务 commit；以每个 Task 的测试检查点替代提交检查点。

---

## 自检结论

- 后端 Store、sandbox、REST、SSE 与前端 API、Hook、菜单、弹窗均有实施任务。
- `deleteSession` 与 `deleteCodeProject` 命名在前后端一致。
- 204、404、409 和 active task 状态集合在规格与计划中一致。
- Project 删除明确保留历史消息，Session 删除明确级联全部关联记录。
- 没有软删除、批量删除、撤销或 outbox 等范围外能力。
