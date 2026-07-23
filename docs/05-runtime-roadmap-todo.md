# Agent Runtime v2 后续 TODO 路线图

> 状态：待实施  
> 更新日期：2026-07-23  
> 范围：在现有“一个 Job 对应一个持久化 ReAct 循环”的架构上补齐恢复、调度、安全、实时一致性、长期记忆和运行治理。  
> 原则：不重新引入 StepRun、嵌套 Planner 或第二套 Context；不为了排队先增加新的业务表；不改变 `agent_messages` 作为权威时间线的地位。

## 1. 当前基线

已经具备：

- 单一 ReAct 主循环，Plan 作为 `update_plan` 工具；
- LangChain Message、ToolCall 和模型 `invoke/stream` 桥接；
- Session、Job、Message、Plan、ToolInvocation、Artifact、HITL 持久化；
- LoopCheckpoint、工具执行 attempt、工具结果重放和人工 Resume；
- Context MessageGroup、统一 Context Memory、Token 预测和 ModelCall 审计；
- 文件、Shell、浏览、Artifact、开发服务器和资源卡片；
- SSE 实时投影与 SessionView 刷新重建；
- 后端单元测试、PostgreSQL 事务集成测试和前端状态投影测试。

当前阶段的重点不再是扩充 ReAct 内核，而是补齐 Runtime 控制面。

## 2. TODO 总览

| ID | 优先级 | 状态 | 事项 | 目标 |
| --- | --- | --- | --- | --- |
| REC-01 | P0 | [ ] | `unknown` ToolInvocation 人工确认 | 副作用工具中断后可以安全决定继续、重试或失败 |
| REC-02 | P0 | [ ] | Resume 执行时间预算修正 | 恢复后的新 attempt 不因原 Job 创建时间立即超时 |
| SCH-01 | P0/P1 | [ ] | Job Dispatcher 与并发控制 | 使用现有 Job 表实现排队、限流和公平执行 |
| SEC-01 | P0（生产） | [ ] | 可信本地与隔离运行模式 | 保留本地完整能力，同时提供可安全部署的执行边界 |
| RT-01 | P1 | [ ] | Durable SSE cursor/replay | 断线、刷新和多实例下可以精确补齐事件 |
| VIEW-01 | P1 | [ ] | SessionView 一致性快照 | 一次 View 请求不会读到相互错位的数据库事实 |
| MEM-01 | P1 | [ ] | 历史精确回查工具 | Context 压缩后仍能按需找回原始消息和结果 |
| MOD-01 | P1 | [ ] | 模型调用治理 | 增加重试、限流、熔断、成本预算和可选降级 |
| OBS-01 | P1/P2 | [ ] | 运行指标与链路追踪 | 能快速回答 Job 为什么慢、失败或消耗异常 |
| TEST-01 | P1 | [ ] | 故障恢复与行为评测 | 通过真实 kill/restart/Resume 和复杂任务回归验证 |
| AUD-01 | P2 | [ ] | 内部审计查询接口 | 不查数据库即可查看 Checkpoint 和工具执行历史 |
| CLEAN-01 | P2 | [ ] | 剩余边界收口 | 降低工具、SSE、删除流程和异常映射的耦合 |

## 3. P0：恢复闭环

### REC-01：`unknown` ToolInvocation 人工确认

#### 当前问题

`side_effecting` 工具在执行开始后、结果提交前中断时，Runtime 无法判断外部副作用是否已经发生。当前会把 Invocation 标记为 `unknown`，随后将 Job 置为 `failed`，没有人工确认后继续的入口。

#### 目标状态

```text
ToolInvocation unknown
├─ confirm_completed   → 补交 ToolResult → 推进 Checkpoint → 继续同一 Job
├─ confirm_not_started → 重置 pending    → 新 execution attempt → 继续同一 Job
└─ confirm_failed      → 提交失败结果     → 让 ReAct 读取失败并继续决策
```

Job 在确认前应保持非终态，例如继续使用 `recovery_required`；不能先变成 `failed` 再试图复活终态 Job。

#### 预计改动

- 新增人工确认命令和事务：

```http
POST /tool-invocations/:invocationId/reconcile
```

- 请求至少包含：

```ts
type ToolReconciliation =
  | { outcome: 'completed'; content: string; result?: unknown }
  | { outcome: 'not_executed' }
  | { outcome: 'failed'; code: string; message: string; details?: unknown };
```

- 使用 Invocation version 或稳定确认 ID 保证幂等；
- `completed/failed` 分支必须补齐合法 ToolMessage；
- `not_executed` 只能为对应 Invocation 创建新的执行 attempt；
- 事务完成后发布 Invocation、Message、Job 的正式事件；
- 前端展示风险说明、确认表单和明确的不可逆提示。

#### 验收标准

- [ ] `unknown` 状态不会被 Runtime 自动重放；
- [ ] 重复提交相同确认不会产生重复 ToolMessage；
- [ ] 三种确认结果都能形成合法的 LangChain ToolCall/ToolMessage 序列；
- [ ] 确认后从原 Checkpoint 继续同一个 Job；
- [ ] 旧 worker/attempt 的迟到结果仍被数据库 fence 拒绝；
- [ ] PostgreSQL 集成测试覆盖三种分支和并发确认。

### REC-02：Resume 执行时间预算

#### 当前问题

ReAct deadline 当前按：

```ts
job.startedAtMs + executionDeadlineMs
```

计算。Job 暂停较久后再 Resume，新 attempt 可能刚开始就超时。

#### 目标状态

区分两种限制：

- `attemptExecutionDeadline`：每次开始或恢复 attempt 时重新计算；
- `jobMaximumLifetime`：可选的整个 Job 最长生命周期，默认不由 attempt deadline 代替。

#### 验收标准

- [ ] Resume 后至少获得完整的一次 attempt 执行窗口；
- [ ] `maxIterations` 和 `maxToolCalls` 仍从 Checkpoint 的累计计数继续；
- [ ] 可选 Job 总生命周期有独立配置和独立错误码；
- [ ] 测试覆盖暂停时间超过默认 15 分钟后恢复。

## 4. P0/P1：调度与背压

### SCH-01：Job Dispatcher

#### 当前问题

HTTP 创建 Job 后会立即修改为 `running`，再通过本进程内的
`#startJobExecutionInBackground()` 启动。当前没有：

- Runtime 全局最大并发；
- 模型 provider 并发槽位；
- 等待队列和公平性；
- 排队 Job 的取消；
- 多 Runtime 实例安全领取待执行 Job；
- 过载时的背压和可观测等待状态。

#### 目标状态

第一阶段复用现有 `agent_jobs`，不增加队列表：

```text
HTTP 创建 Job(created)
→ Dispatcher 查询可执行 Job
→ 有并发槽位时原子启动 attempt
→ running
→ 执行结束后释放槽位
→ 调度下一条
```

多实例领取使用 PostgreSQL 行锁与 `FOR UPDATE SKIP LOCKED`。建议使用通俗命名，例如：

- `startNextPendingJob`
- `JobDispatcher`
- `activeExecutions`
- `maxConcurrentJobs`

#### 验收标准

- [ ] 同一 Session 仍只允许一个活跃 Job；
- [ ] 全局并发严格不超过配置；
- [ ] 排队 Job 可以取消且不会执行；
- [ ] 两个 Runtime 实例不会启动同一个 Job；
- [ ] 服务在 Job 创建与执行启动之间退出时，Job 仍可被其他 Dispatcher 执行；
- [ ] 前端能区分 `created/queued` 与 `running`，但不展示内部心跳。

## 5. P0（生产）：权限与隔离

### SEC-01：运行安全策略

#### 当前问题

`run_shell` 当前以 Runtime 进程的宿主机权限运行，允许完整网络、绝对路径和 Session workspace 外目录。这是有意设计的本地可信模式，但不能直接作为多人或远程部署的默认策略。

HTTP 当前也没有认证、Session 所有权和租户隔离。

#### 目标状态

提供两种明确运行配置：

```text
local_trusted
  面向个人本地 Agent
  保留宿主机能力
  UI 明确展示高权限模式

isolated
  面向共享或远程部署
  容器/虚拟化 workspace
  CPU、内存、磁盘和执行时间限制
  网络策略
  危险工具审批
  Secret Broker
  用户与 Session 所有权
```

#### 验收标准

- [ ] 未显式选择时，共享部署不能默认进入 `local_trusted`；
- [ ] 危险工具由 Runtime 策略决定是否需要审批，不能只依赖提示词；
- [ ] Secret 不进入 ToolResult、SSE、ModelCall input 或普通日志；
- [ ] Session、Artifact、进程和调试 Context API 都校验所有权；
- [ ] 隔离模式无法通过绝对路径、软链接或 Shell 逃逸 workspace。

## 6. P1：实时一致性

### RT-01：Durable SSE cursor/replay

#### 当前问题

SSE 使用进程内 RxJS Subject：

- 服务重启后旧事件消失；
- 多实例不能共享广播；
- 不支持 Last-Event-ID 精确重放；
- 当前依赖重新加载 SessionView 最终收敛；
- 快照加载期间仍存在新事件到达的竞态。

#### 目标状态

稳定业务事实提交时生成 Session 级单调序列：

```text
数据库事务提交事实
→ 同事务记录 session event/outbox
→ SSE 按 sessionSequence 推送
→ 客户端携带 cursor 重连
→ Server 补发 cursor 之后的事件
```

`message.delta` 可以继续是易失草稿；正式 entity upsert 必须可补拉。

#### 验收标准

- [ ] 刷新或断线不会遗漏已提交事实；
- [ ] 多实例订阅结果一致；
- [ ] 重复事件由 sequence/version 安全去重；
- [ ] delta 丢失不影响最终消息；
- [ ] 心跳等内部运行信息不进入前端事实事件流。

### VIEW-01：SessionView 一致性快照

#### 当前问题

SessionView 当前并行读取 Jobs、Messages、Invocations、Plans、Artifacts 等数据，这些查询不在同一个数据库快照中，理论上可能组合出不同提交时刻的事实。

#### 目标状态

- PostgreSQL 业务事实在同一个 `REPEATABLE READ` 只读事务中加载；
- 本地 ManagedProcess 继续作为明确标注的实时 overlay；
- View 返回与快照对应的 `sessionSequence/cursor`。

#### 验收标准

- [ ] View 内不会出现 ToolInvocation 已完成但结果 Message 尚不可见等跨快照错位；
- [ ] View cursor 可以直接作为 SSE replay 起点；
- [ ] 前端 `normalize(view)` 与增量 reducer 在同一序列规则下收敛。

## 7. P1：长期记忆精确回查

### MEM-01：历史查询工具

#### 当前问题

统一 Context Memory 是有损摘要。旧原始 Message 和 ToolResult 仍在 PostgreSQL 中，但 Agent 没有按需重新读取它们的工具。当用户追问很早以前的精确细节时，模型只能依赖摘要。

#### 第一阶段方案

暂不引入向量数据库，先增加：

- `search_session_history`
- `read_message_range`
- `find_artifact`
- `read_artifact`

查询返回稳定 Message ID、rowId、Job ID、Artifact ID 和有限预览；模型再按 ID 精确读取所需内容。

#### 验收标准

- [ ] 搜索工具只读取当前 Session；
- [ ] ToolCall/ToolResult 协议组不会被拆成非法片段；
- [ ] 搜索结果可追溯到原始事实；
- [ ] 大结果有分页、字符限制和 Token 投影；
- [ ] 被 Context Memory 覆盖的内容仍可通过工具取回。

## 8. P1：模型调用治理

### MOD-01：Provider resiliency 与预算

需要增加：

- 429、超时、连接错误和 5xx 的分类重试；
- 指数退避与 Retry-After；
- Provider 并发和请求速率限制；
- 可选模型降级与熔断；
- 单 Job 最大模型调用数；
- 单 Job Token/成本预算；
- 压缩模型调用与主 ReAct 调用分别统计；
- 重试必须生成独立 ModelCall attempt，不能覆盖原审计记录。

验收标准：

- [ ] 不重试协议错误、无效工具参数等确定性错误；
- [ ] 取消信号可以终止退避和正在进行的请求；
- [ ] Retry/降级后的模型、原因和 usage 可审计；
- [ ] 达到预算时使用稳定错误码结束 Job；
- [ ] 不因自动重试重复提交工具副作用。

## 9. P1/P2：可观测性与验证

### OBS-01：运行指标与追踪

建议增加：

- Job 排队、执行、等待输入和恢复耗时；
- 每轮 ReAct 模型耗时、工具耗时和 Context 构建耗时；
- Provider 错误率和重试次数；
- Context 压缩次数、压缩前后 Tokens 和摘要失败率；
- Checkpoint 恢复次数与 `unknown` 数量；
- 活跃执行、排队 Job 和 Session 数；
- traceId/jobId/attemptId/modelCallId/toolInvocationId 关联。

### TEST-01：故障测试和 Agent Eval

需要覆盖：

- 模型流式输出期间杀死 Server；
- 五工具批次执行到中间时杀死 Server；
- 文件写入后、ToolResult 事务前退出；
- side-effecting 工具结果未知后的人工确认；
- SSE 断线、重连和事件补发；
- 两个 Runtime 实例并发调度；
- Context 压缩后追问早期精确细节；
- 真实模型复杂任务的成功率、工具选择和 Plan 完成度。

验收不只看 HTTP 200，而应验证数据库事实、Checkpoint、View 和最终 Artifact。

## 10. P2：审计与边界收口

### AUD-01：只读审计接口

增加只读接口查看：

- Job 的完整 Checkpoint 历史；
- ToolInvocation 的 ExecutionAttempt 历史；
- Job 的 attempt lineage；
- ModelCall 输入、输出 disposition 和 usage；
- 恢复决策与人工 reconciliation 记录。

默认面向调试或管理员，不进入模型 Context。

### CLEAN-01：剩余耦合

- `update_plan` 工具不应直接依赖 SSE Publisher；工具只提交事实，统一事件发布由 Runtime writer/transaction result 完成；
- Session 删除的数据库、workspace 和本地进程清理需要明确可重试的 Saga，而不是假装跨系统原子；
- RuntimeExceptionFilter 为所有预期业务错误提供稳定 4xx 映射；
- SessionView 数据加载收口到 Store 查询对象，避免 View 层拼多次不一致读取；
- 定期清理或归档大体积 ModelCall input、ToolResult、ContextSummary superseded chain 和旧 Artifact revision；
- 心跳只更新内部执行有效期，不更新 Job version、updatedAt 或发送 SSE。

## 11. 推荐实施顺序

```text
阶段 1：恢复闭环
  REC-01 unknown reconciliation
  REC-02 attempt deadline
  TEST-01 对应故障测试

阶段 2：运行调度
  SCH-01 Dispatcher
  MOD-01 provider 并发与基础重试
  OBS-01 基础指标

阶段 3：长期会话能力
  MEM-01 历史精确回查
  AUD-01 审计接口

阶段 4：一致性与部署
  VIEW-01 一致性快照
  RT-01 durable SSE
  SEC-01 隔离与权限

阶段 5：长期治理
  Agent Eval
  成本预算
  数据归档与清理
```

如果目标从个人本地 Agent 切换为多人或远程产品，`SEC-01` 必须前移到阶段 1。

## 12. 明确暂不做

- 不重新引入 StepRun；
- 不恢复 Planner/StepExecutor/PlanFinalizer 嵌套执行器；
- 不迁移 LangGraph 来替代当前 Runtime；
- 不为 Dispatcher 先创建新队列表；
- 不把本机 PID 和端口作为跨机器业务事实持久化；
- 不先建设向量数据库，优先验证 SQL 历史回查；
- 不继续堆更多工具来掩盖恢复、调度和安全问题；
- 不承诺任意外部副作用 exactly-once，优先保证可审计、可确认和不盲目重放。
