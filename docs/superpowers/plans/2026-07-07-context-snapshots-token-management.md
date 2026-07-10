# Context Snapshots 与 Token 管理实施计划

> **给 agentic workers 的要求：** 实施本计划时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务执行。每个步骤使用 checkbox 跟踪。

**目标：** 增加持久化 context snapshot 和 token-budgeted context construction，同时不改变 canonical session/UI message timeline。

**架构：** `agent_messages` 继续作为事实源；新增 `agent_context_snapshots` 作为派生压缩缓存；新增 session-aware `ContextBuilder` 路径。保留现有 `AgentMessage[] -> BaseMessage[]` 转换能力，用于测试、短上下文和局部构造。

**技术栈：** TypeScript、LangChain `BaseMessage`、Vitest、Postgres `pg`、现有 `AgentSessionStore`。

---

## 文件结构

- 新建 `src/domain/context-snapshot.ts`：context snapshot domain 类型。
- 修改 `src/domain/index.ts`：导出 context snapshot 类型。
- 修改 `src/storage/session-store.ts`：增加 snapshot store 接口。
- 修改 `src/storage/postgres-session-store.ts`：创建 snapshot 表并实现 Postgres 方法。
- 修改 `src/storage/file-session-store.ts`：实现文件/内存版 snapshot 方法，服务测试和本地 fallback。
- 新建 `src/context/token-budget.ts`：token 估算与预算判断。
- 新建 `src/context/context-compressor.ts`：上下文压缩接口和基础实现。
- 修改 `src/context/context-builder.ts`：保留 `build(messages)`，新增 `buildForModel(...)`。
- 修改 `src/context/index.ts`：导出新增 context 工具。
- 修改 `src/orchestration/react-agent.ts`：模型调用前改用 session-aware context。
- 修改 `src/orchestration/planner-react-agent.ts`：安全接入 session-aware context。
- 修改 `docs/postgres-storage.md`：修正旧 `seq/message_seq` 文档，加入 snapshot 说明。
- 新增 `tests/context-snapshots.test.ts`。
- 必要时修改已有测试。

---

## Task 1：增加 Context Snapshot Domain 类型

**文件：**

- 新建：`src/domain/context-snapshot.ts`
- 修改：`src/domain/index.ts`
- 测试：`tests/context-snapshots.test.ts`

- [ ] **Step 1：先写失败测试**

创建 `tests/context-snapshots.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { AgentContextSnapshotStatus, AgentContextSnapshotKind } from '../src/domain/index.js';

describe('context snapshot domain', () => {
  it('defines rolling active snapshots', () => {
    expect(AgentContextSnapshotKind.RollingSummary).toBe('rolling_summary');
    expect(AgentContextSnapshotStatus.Active).toBe('active');
  });
});
```

- [ ] **Step 2：运行失败测试**

```bash
npm test -- tests/context-snapshots.test.ts
```

预期：失败，因为 `AgentContextSnapshotKind` 尚未导出。

- [ ] **Step 3：增加 domain 类型**

创建 `src/domain/context-snapshot.ts`：

```ts
export enum AgentContextSnapshotKind {
  RollingSummary = 'rolling_summary',
  TaskSummary = 'task_summary',
  ToolSummary = 'tool_summary',
  MemorySummary = 'memory_summary',
}

export enum AgentContextSnapshotStatus {
  Active = 'active',
  Superseded = 'superseded',
  Failed = 'failed',
}

export enum AgentContextBuildStrategy {
  Full = 'full',
  SnapshotTail = 'snapshot_tail',
  CompressedThenSnapshotTail = 'compressed_then_snapshot_tail',
  TailOnlyFallback = 'tail_only_fallback',
}

export interface AgentContextSnapshot {
  id: string;
  sessionId: string;
  taskId?: string;
  kind: AgentContextSnapshotKind;
  status: AgentContextSnapshotStatus;
  sourceRowIdStart: number;
  sourceRowIdEnd: number;
  baseSnapshotId?: string;
  supersedesSnapshotId?: string;
  summary: string;
  summaryFormat: 'markdown' | 'json';
  sourceMessageCount: number;
  sourceTokenCount?: number;
  summaryTokenCount?: number;
  model?: string;
  compressionPromptVersion: string;
  checksum?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
```

修改 `src/domain/index.ts`：

```ts
export * from './context-snapshot.js';
```

- [ ] **Step 4：运行测试**

```bash
npm test -- tests/context-snapshots.test.ts
```

预期：通过。

---

## Task 2：扩展 Session Store 接口

**文件：**

- 修改：`src/storage/session-store.ts`
- 修改：`src/storage/file-session-store.ts`
- 测试：`tests/store.test.ts`

- [ ] **Step 1：增加 store 测试**

在 `tests/store.test.ts` 增加：

```ts
import {
  AgentContextSnapshotKind,
  AgentContextSnapshotStatus,
} from '../src/domain/index.js';

it('stores and replaces active context snapshots', async () => {
  const store = createStore();
  const now = 1000;
  await store.createSession({ id: 'session_ctx', mode: 'react', now });

  const first = await store.createContextSnapshot({
    id: 'snap_1',
    sessionId: 'session_ctx',
    kind: AgentContextSnapshotKind.RollingSummary,
    status: AgentContextSnapshotStatus.Active,
    sourceRowIdStart: 1,
    sourceRowIdEnd: 10,
    summary: 'first summary',
    summaryFormat: 'markdown',
    sourceMessageCount: 10,
    compressionPromptVersion: 'v1',
    now,
  });

  expect(first.status).toBe(AgentContextSnapshotStatus.Active);

  const second = await store.replaceActiveContextSnapshot({
    id: 'snap_2',
    sessionId: 'session_ctx',
    kind: AgentContextSnapshotKind.RollingSummary,
    sourceRowIdStart: 1,
    sourceRowIdEnd: 20,
    summary: 'second summary',
    summaryFormat: 'markdown',
    sourceMessageCount: 20,
    compressionPromptVersion: 'v1',
    supersedesSnapshotId: 'snap_1',
    now: now + 1,
  });

  expect(second.status).toBe(AgentContextSnapshotStatus.Active);
  expect(await store.getActiveContextSnapshot('session_ctx')).toMatchObject({
    id: 'snap_2',
    summary: 'second summary',
  });
});
```

- [ ] **Step 2：运行失败测试**

```bash
npm test -- tests/store.test.ts
```

预期：失败，因为 snapshot store 方法还不存在。

- [ ] **Step 3：增加接口类型**

修改 `src/storage/session-store.ts`，引入类型：

```ts
import type {
  AgentContextSnapshot,
  AgentContextSnapshotKind,
  AgentContextSnapshotStatus,
} from '../domain/index.js';
```

新增 input 类型：

```ts
export interface CreateContextSnapshotInput {
  id: string;
  sessionId: string;
  taskId?: string;
  kind: AgentContextSnapshotKind;
  status: AgentContextSnapshotStatus;
  sourceRowIdStart: number;
  sourceRowIdEnd: number;
  baseSnapshotId?: string;
  supersedesSnapshotId?: string;
  summary: string;
  summaryFormat: 'markdown' | 'json';
  sourceMessageCount: number;
  sourceTokenCount?: number;
  summaryTokenCount?: number;
  model?: string;
  compressionPromptVersion: string;
  checksum?: string;
  metadata?: Record<string, unknown>;
  now: number;
}

export type ReplaceActiveContextSnapshotInput = Omit<CreateContextSnapshotInput, 'status'>;
```

在 `AgentSessionStore` 中新增方法：

```ts
getActiveContextSnapshot(sessionId: string): Promise<AgentContextSnapshot | null>;
createContextSnapshot(input: CreateContextSnapshotInput): Promise<AgentContextSnapshot>;
replaceActiveContextSnapshot(input: ReplaceActiveContextSnapshotInput): Promise<AgentContextSnapshot>;
listContextSnapshots(sessionId: string): Promise<AgentContextSnapshot[]>;
```

- [ ] **Step 4：实现 file store**

修改 `src/storage/file-session-store.ts`，增加 `context-snapshots.jsonl` 的读写集合。

`replaceActiveContextSnapshot` 逻辑：

1. 找出同 session 的 active `rolling_summary`。
2. 标记为 `superseded`。
3. 写入新的 active snapshot。
4. 返回新 snapshot。

- [ ] **Step 5：运行测试**

```bash
npm test -- tests/store.test.ts tests/context-snapshots.test.ts
```

预期：通过。

---

## Task 3：增加 Postgres Snapshot 存储

**文件：**

- 修改：`src/storage/postgres-session-store.ts`
- 测试：`tests/postgres-store.test.ts`

- [ ] **Step 1：增加 Postgres 测试**

在 `tests/postgres-store.test.ts` 中增加：

```ts
it('persists active context snapshots in postgres', async () => {
  const store = createPostgresStore();
  const now = Date.now();
  await store.createSession({ id: 'session_pg_ctx', mode: 'react', now });

  await store.replaceActiveContextSnapshot({
    id: 'snap_pg_1',
    sessionId: 'session_pg_ctx',
    kind: AgentContextSnapshotKind.RollingSummary,
    sourceRowIdStart: 1,
    sourceRowIdEnd: 5,
    summary: 'pg summary',
    summaryFormat: 'markdown',
    sourceMessageCount: 5,
    compressionPromptVersion: 'v1',
    now,
  });

  expect(await store.getActiveContextSnapshot('session_pg_ctx')).toMatchObject({
    id: 'snap_pg_1',
    sourceRowIdEnd: 5,
  });
});
```

- [ ] **Step 2：运行失败测试**

```bash
npm test -- tests/postgres-store.test.ts
```

预期：失败，因为表和方法尚未实现。

- [ ] **Step 3：创建表和索引**

在 `src/storage/postgres-session-store.ts` 的初始化逻辑中增加：

```sql
create table if not exists agent_context_snapshots (
  id text primary key,
  session_id text not null references agent_sessions(id) on delete cascade,
  task_id text references agent_tasks(id) on delete set null,
  kind text not null,
  status text not null,
  source_row_id_start bigint not null,
  source_row_id_end bigint not null,
  base_snapshot_id text references agent_context_snapshots(id) on delete set null,
  supersedes_snapshot_id text references agent_context_snapshots(id) on delete set null,
  summary text not null,
  summary_format text not null default 'markdown',
  source_message_count integer not null default 0,
  source_token_count integer,
  summary_token_count integer,
  model text,
  compression_prompt_version text not null,
  checksum text,
  metadata jsonb,
  created_at_ms bigint not null,
  updated_at_ms bigint not null
);

create index if not exists idx_context_snapshots_session_active
  on agent_context_snapshots(session_id, status, source_row_id_end desc);

create index if not exists idx_context_snapshots_session_range
  on agent_context_snapshots(session_id, source_row_id_start, source_row_id_end);

create index if not exists idx_context_snapshots_task
  on agent_context_snapshots(task_id);

create unique index if not exists uniq_context_snapshots_active_rolling
  on agent_context_snapshots(session_id)
  where kind = 'rolling_summary'
    and status = 'active';
```

- [ ] **Step 4：实现 Postgres 方法**

新增方法：

```ts
async getActiveContextSnapshot(sessionId: string): Promise<AgentContextSnapshot | null>
async createContextSnapshot(input: CreateContextSnapshotInput): Promise<AgentContextSnapshot>
async replaceActiveContextSnapshot(input: ReplaceActiveContextSnapshotInput): Promise<AgentContextSnapshot>
async listContextSnapshots(sessionId: string): Promise<AgentContextSnapshot[]>
```

`replaceActiveContextSnapshot` 必须使用事务：

```sql
update agent_context_snapshots
set status = 'superseded',
    updated_at_ms = $now
where session_id = $sessionId
  and kind = 'rolling_summary'
  and status = 'active';
```

然后插入新的 `active` row。

- [ ] **Step 5：运行 Postgres 测试**

```bash
npm test -- tests/postgres-store.test.ts
```

预期：通过。

---

## Task 4：增加 Token Budget 工具

**文件：**

- 新建：`src/context/token-budget.ts`
- 修改：`src/context/index.ts`
- 测试：`tests/context-snapshots.test.ts`

- [ ] **Step 1：增加 token budget 测试**

在 `tests/context-snapshots.test.ts` 增加：

```ts
import { TokenBudgetManager, DEFAULT_TOKEN_BUDGET } from '../src/context/index.js';

it('detects when context exceeds compression threshold', () => {
  const manager = new TokenBudgetManager({
    ...DEFAULT_TOKEN_BUDGET,
    maxContextTokens: 100,
    reservedOutputTokens: 20,
    compressionTriggerRatio: 0.5,
  });

  expect(manager.shouldCompress(30)).toBe(false);
  expect(manager.shouldCompress(41)).toBe(true);
});
```

- [ ] **Step 2：运行失败测试**

```bash
npm test -- tests/context-snapshots.test.ts
```

预期：失败，因为 token budget 工具不存在。

- [ ] **Step 3：实现 token budget**

创建 `src/context/token-budget.ts`：

```ts
export interface TokenBudgetConfig {
  maxContextTokens: number;
  reservedOutputTokens: number;
  compressionTriggerRatio: number;
  minTailMessages: number;
  minTailTokens: number;
  maxSnapshotTokens: number;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudgetConfig = {
  maxContextTokens: 32000,
  reservedOutputTokens: 4000,
  compressionTriggerRatio: 0.75,
  minTailMessages: 12,
  minTailTokens: 4000,
  maxSnapshotTokens: 3000,
};

export class ApproximateTokenEstimator {
  countText(text: string): number {
    return Math.ceil(text.length / 3);
  }
}

export class TokenBudgetManager {
  constructor(
    private readonly config: TokenBudgetConfig = DEFAULT_TOKEN_BUDGET,
  ) {}

  maxInputTokens(): number {
    return this.config.maxContextTokens - this.config.reservedOutputTokens;
  }

  compressionThreshold(): number {
    return Math.floor(this.maxInputTokens() * this.config.compressionTriggerRatio);
  }

  shouldCompress(estimatedInputTokens: number): boolean {
    return estimatedInputTokens > this.compressionThreshold();
  }

  getConfig(): TokenBudgetConfig {
    return this.config;
  }
}
```

修改 `src/context/index.ts`：

```ts
export * from './token-budget.js';
```

- [ ] **Step 4：运行测试**

```bash
npm test -- tests/context-snapshots.test.ts
```

预期：通过。

---

## Task 5：增加 Context Compressor

**文件：**

- 新建：`src/context/context-compressor.ts`
- 修改：`src/context/index.ts`
- 测试：`tests/context-snapshots.test.ts`

- [ ] **Step 1：增加 compressor 测试**

在 `tests/context-snapshots.test.ts` 增加：

```ts
import { BasicContextCompressor } from '../src/context/index.js';

it('creates a structured rolling summary', async () => {
  const compressor = new BasicContextCompressor();
  const result = await compressor.compress({
    sessionId: 'session_ctx',
    taskId: 'task_ctx',
    messages: [
      { role: 'user', content: '帮我查资料' },
      { role: 'assistant', content: '我会先搜索资料。' },
    ],
    previousSummary: 'Earlier summary',
    maxSummaryTokens: 3000,
  });

  expect(result.summary).toContain('## Conversation Summary');
  expect(result.summary).toContain('Earlier summary');
  expect(result.summaryTokenCount).toBeGreaterThan(0);
});
```

- [ ] **Step 2：运行失败测试**

```bash
npm test -- tests/context-snapshots.test.ts
```

预期：失败，因为 compressor 不存在。

- [ ] **Step 3：实现基础 compressor**

创建 `src/context/context-compressor.ts`：

```ts
import type { AgentMessage } from '../domain/index.js';
import { ApproximateTokenEstimator } from './token-budget.js';

export interface CompressContextInput {
  sessionId: string;
  taskId?: string;
  messages: Array<Pick<AgentMessage, 'role' | 'content' | 'toolCalls' | 'toolResult' | 'metadata'>>;
  previousSummary?: string;
  maxSummaryTokens: number;
}

export interface CompressContextResult {
  summary: string;
  summaryTokenCount: number;
  sourceTokenCount: number;
  compressionPromptVersion: string;
}

export interface ContextCompressor {
  compress(input: CompressContextInput): Promise<CompressContextResult>;
}

export class BasicContextCompressor implements ContextCompressor {
  private readonly estimator = new ApproximateTokenEstimator();

  async compress(input: CompressContextInput): Promise<CompressContextResult> {
    const sourceText = input.messages
      .map(message => `${message.role}: ${message.content}`)
      .join('\n');

    const summary = [
      '## Conversation Summary',
      input.previousSummary ?? 'No previous summary.',
      '',
      '## Recent Compressed Messages',
      sourceText,
      '',
      '## Open Questions',
      'None recorded.',
      '',
      '## Constraints',
      'Preserve tool results, user goals, and active planner state when present.',
    ].join('\n');

    return {
      summary,
      summaryTokenCount: this.estimator.countText(summary),
      sourceTokenCount: this.estimator.countText(sourceText),
      compressionPromptVersion: 'basic-v1',
    };
  }
}
```

修改 `src/context/index.ts`：

```ts
export * from './context-compressor.js';
```

- [ ] **Step 4：运行测试**

```bash
npm test -- tests/context-snapshots.test.ts
```

预期：通过。

---

## Task 6：增加 Session-Aware ContextBuilder

**文件：**

- 修改：`src/context/context-builder.ts`
- 测试：`tests/context-builder.test.ts`

- [ ] **Step 1：增加 context builder 测试**

在 `tests/context-builder.test.ts` 增加：

```ts
it('builds context from active snapshot plus tail messages', async () => {
  const store = createStore();
  const now = Date.now();
  await store.createSession({ id: 'session_build_ctx', mode: 'react', now });
  const task = await store.createTask({
    id: 'task_build_ctx',
    sessionId: 'session_build_ctx',
    kind: 'react',
    executor: 'react',
    now,
  });

  await store.appendMessage({
    id: 'msg_old',
    sessionId: 'session_build_ctx',
    taskId: task.id,
    role: 'user',
    content: 'old message',
    createdAt: now,
  });

  await store.replaceActiveContextSnapshot({
    id: 'snap_build',
    sessionId: 'session_build_ctx',
    kind: AgentContextSnapshotKind.RollingSummary,
    sourceRowIdStart: 1,
    sourceRowIdEnd: 1,
    summary: '## Conversation Summary\nold message summarized',
    summaryFormat: 'markdown',
    sourceMessageCount: 1,
    compressionPromptVersion: 'v1',
    now,
  });

  await store.appendMessage({
    id: 'msg_tail',
    sessionId: 'session_build_ctx',
    taskId: task.id,
    role: 'user',
    content: 'new tail message',
    createdAt: now + 1,
  });

  const builder = new ContextBuilder();
  const built = await builder.buildForModel({
    store,
    sessionId: 'session_build_ctx',
    taskId: task.id,
    model: 'test-model',
    systemPrompt: 'You are helpful.',
  });

  expect(built.strategy).toBe(AgentContextBuildStrategy.SnapshotTail);
  expect(built.messages.map(message => String(message.content)).join('\n')).toContain('old message summarized');
  expect(built.messages.map(message => String(message.content)).join('\n')).toContain('new tail message');
});
```

- [ ] **Step 2：运行失败测试**

```bash
npm test -- tests/context-builder.test.ts
```

预期：失败，因为 `buildForModel` 不存在。

- [ ] **Step 3：实现 `buildForModel`**

在 `src/context/context-builder.ts` 增加输入/输出类型：

```ts
export interface BuildModelContextInput {
  store: AgentSessionStore;
  sessionId: string;
  taskId?: string;
  model?: string;
  systemPrompt?: string;
  budget?: TokenBudgetConfig;
  compressor?: ContextCompressor;
}

export interface BuiltModelContext {
  messages: BaseMessage[];
  snapshot?: AgentContextSnapshot;
  includedRowIdStart?: number;
  includedRowIdEnd?: number;
  estimatedTokens: number;
  strategy: AgentContextBuildStrategy;
}
```

实现逻辑：

```ts
async buildForModel(input: BuildModelContextInput): Promise<BuiltModelContext> {
  const budget = input.budget ?? DEFAULT_TOKEN_BUDGET;
  const manager = new TokenBudgetManager(budget);
  const estimator = new ApproximateTokenEstimator();
  const snapshot = await input.store.getActiveContextSnapshot(input.sessionId);
  const tail = snapshot
    ? await input.store.listMessagesAfterRowId(input.sessionId, snapshot.sourceRowIdEnd)
    : await input.store.listMessages(input.sessionId);

  const syntheticMessages = [
    ...(input.systemPrompt ? [this.systemMessage(input.systemPrompt)] : []),
    ...(snapshot ? [this.systemMessage(snapshot.summary)] : []),
    ...tail,
  ];

  const estimatedTokens = estimator.countText(
    syntheticMessages.map(message => message.content).join('\n')
  );

  if (!manager.shouldCompress(estimatedTokens)) {
    return {
      messages: this.build(syntheticMessages),
      snapshot: snapshot ?? undefined,
      includedRowIdStart: tail[0]?.rowId,
      includedRowIdEnd: tail.at(-1)?.rowId,
      estimatedTokens,
      strategy: snapshot ? AgentContextBuildStrategy.SnapshotTail : AgentContextBuildStrategy.Full,
    };
  }

  return this.compressAndRebuild(input, snapshot, tail, manager);
}
```

辅助函数需要创建 synthetic `AgentMessage`，`role = 'system'`，不持久化。

- [ ] **Step 4：运行 context builder 测试**

```bash
npm test -- tests/context-builder.test.ts tests/context-snapshots.test.ts
```

预期：通过。

---

## Task 7：接入 React Agent

**文件：**

- 修改：`src/orchestration/react-agent.ts`
- 测试：`tests/orchestration/react-agent-patch.test.ts`

- [ ] **Step 1：增加回归测试**

增加一个测试，使用记录调用次数的 `ContextBuilder` 子类，证明 `ReactAgent` 使用 `buildForModel`。

- [ ] **Step 2：运行失败测试**

```bash
npm test -- tests/orchestration/react-agent-patch.test.ts
```

预期：失败，因为 `ReactAgent` 仍然调用 `build(messages)`。

- [ ] **Step 3：替换 context 构造逻辑**

把 `src/orchestration/react-agent.ts` 中类似逻辑：

```ts
const messages = await this.config.store.listMessages(input.sessionId);
const context = this.config.contextBuilder.build(messages);
```

替换为：

```ts
const context = await this.config.contextBuilder.buildForModel({
  store: this.config.store,
  sessionId: input.sessionId,
  taskId: task.id,
  model: this.config.modelName,
  systemPrompt: this.config.systemPrompt,
});
```

然后把 `context.messages` 传给 core runtime。

- [ ] **Step 4：运行 orchestration 测试**

```bash
npm test -- tests/orchestration/react-agent-patch.test.ts tests/orchestrator.test.ts
```

预期：通过。

---

## Task 8：谨慎接入 Planner React Agent

**文件：**

- 修改：`src/orchestration/planner-react-agent.ts`
- 测试：`tests/planner.test.ts`

- [ ] **Step 1：增加 planner 回归测试**

增加测试验证：

- planner mode 仍然可以创建 plan。
- 至少执行一个 child step。
- snapshot 不会作为普通 message 进入 UI。

- [ ] **Step 2：运行 baseline**

```bash
npm test -- tests/planner.test.ts
```

预期：已有测试通过；新增断言可能失败。

- [ ] **Step 3：接入 snapshot-aware context**

root planner model call 改用 `buildForModel`。

对于 step-local execution，如果当前设计是刻意只使用 step messages，先保留局部 context，不强行把完整 session snapshot 塞进每个 child step。

- [ ] **Step 4：运行 planner 测试**

```bash
npm test -- tests/planner.test.ts tests/context-builder.test.ts
```

预期：通过。

---

## Task 9：更新文档

**文件：**

- 修改：`docs/postgres-storage.md`
- 修改：`docs/session-patch-model.md`

- [ ] **Step 1：替换旧 seq 文档**

在 `docs/postgres-storage.md` 中，将 `message_seq` 和 `seq` 相关内容替换为：

```md
## Message Ordering

`agent_messages.row_id` is a database-assigned global increasing id. It is not
session-local. Session timelines are loaded by filtering `session_id` and
ordering by `row_id`.
```

- [ ] **Step 2：增加 snapshot 章节**

添加：

```md
## Context Snapshots

`agent_context_snapshots` stores derived summaries used by `ContextBuilder`.
Snapshots are not conversation messages and are not rendered in the main UI.
The active rolling snapshot covers messages from `source_row_id_start` through
`source_row_id_end`; tail messages after that range are loaded from
`agent_messages`.
```

- [ ] **Step 3：扫描旧文档**

```bash
rg -n "message_seq|messages\\.seq|real seq| seq" docs src tests
```

预期：没有文档继续声称 session-local `seq` 是当前存储机制。兼容老数据的代码可以保留 legacy `seq` 字样。

---

## Task 10：完整验证

**文件：**

- 所有变更文件

- [ ] **Step 1：运行完整测试**

```bash
npm test
```

预期：通过。

- [ ] **Step 2：运行 typecheck**

```bash
npm run typecheck
```

预期：通过。

- [ ] **Step 3：运行 build**

```bash
npm run build
```

预期：通过。

- [ ] **Step 4：手动验证数据库表**

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'agent_context_snapshots'
order by ordinal_position;
```

预期：表包含 `id`、`session_id`、`kind`、`status`、`source_row_id_start`、`source_row_id_end`、`summary`。

---

## 自检

- 设计覆盖：表设计、snapshot 流程、token budget、失败降级、UI 隔离、未来扩展都已覆盖。
- 占位符扫描：没有依赖未定义未来工作的实施步骤。
- 类型一致性：新增 public name 都在使用前定义。
- 范围控制：第一版只做 rolling snapshot 和 before-model-call compression；长期记忆和 context build audit 作为后续扩展。

