# Postgres Storage

Postgres adapter 通过 `AgentSessionStore` 持久化 agent runtime 的 canonical session state。

## Tables

当前核心表：

- `agent_sessions`
- `agent_tasks`
- `agent_messages`
- `agent_input_requests`
- `agent_context_snapshots`

`agent_messages` 是完整会话事实源。UI 会话恢复、SSE completed event、审计、回放都应该以这张表为准。

`agent_context_snapshots` 是派生缓存，只服务于 `ContextBuilder`，不能当作普通聊天消息展示。

## Message Ordering

`agent_messages.row_id` 是数据库分配的全局递增 id：

```sql
row_id bigint not null default nextval('agent_messages_row_id_seq')
```

它不是 session-local sequence。读取某个 session 的时间线时，必须用 `session_id` 过滤，并按 `row_id` 排序：

```sql
select *
from agent_messages
where session_id = $1
order by row_id asc;
```

读取某个 snapshot 后面的 tail messages：

```sql
select *
from agent_messages
where session_id = $1
  and row_id > $2
order by row_id asc;
```

这比 session 内手动分配序号更简单，也避免了高并发下为了分配 session-local seq 去锁 session row。

## Message Payloads

`agent_messages` 映射 `AppendMessageInput`，再加上数据库生成的 `row_id`：

- `row_id`
- `id`
- `session_id`
- `task_id`
- `role`
- `content`
- `created_at_ms`
- `channel`
- `tool_calls jsonb`
- `tool_result jsonb`
- `metadata jsonb`

Assistant tool calls 存在 assistant message 的 `tool_calls` 上。

Tool result 存在 tool message 的 `tool_result` 上。

OpenAI 协议要求 tool call 和 tool result 在 context 里成对出现。存储层不强行把它们合并成一行；`ContextBuilder` 负责在构造模型上下文时成对恢复。

## Context Snapshots

`agent_context_snapshots` 存储上下文压缩结果：

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
```

第一版只使用：

- `kind = 'rolling_summary'`
- `status = 'active' | 'superseded' | 'failed'`

同一个 session 同时只允许一个 active rolling summary：

```sql
create unique index if not exists uniq_context_snapshots_active_rolling
on agent_context_snapshots(session_id)
where kind = 'rolling_summary'
  and status = 'active';
```

Snapshot 覆盖范围由 `source_row_id_start` 和 `source_row_id_end` 表示。模型上下文构造时使用：

```txt
system/context prompt + active snapshot + messages after source_row_id_end
```

## Task Concurrency

`agent_tasks.version` 是 optimistic-lock counter。Task 创建时 `version = 0`，每次 `updateTask` 都带上期望版本：

```sql
where id = $id
  and version = $expected_version
```

并写入：

```sql
version = version + 1
```

如果调用方基于过期 task snapshot 更新，存储层会抛出：

```txt
Task was updated concurrently: <taskId>
```

同一个 session 同时只允许一个 active root task：

```sql
create unique index uniq_agent_tasks_active_root_per_session
on agent_tasks(session_id)
where parent_task_id is null
  and status in ('created', 'running', 'waiting_user_input', 'resuming');
```

Planner step task 是 child task，因此 planner root task 可以串行推进多个 child steps。这个约束主要防止浏览器多窗口同时启动两个 root run 去写同一个 session timeline。

## HITL Safety

`answerInputRequest` 使用 `for update` 锁住 input request row，只允许：

```txt
pending -> answered
```

同一个 request 被重复回答时，存储层会在修改 answer 前抛错。

用户输入被回答后，编排层会重新加载最新 task 状态。如果另一个请求已经恢复了 task，后到的 answer 不会再启动第二个 model loop。

