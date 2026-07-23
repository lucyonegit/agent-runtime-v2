# Agent Runtime v2 当前实现全链路

> 文档性质：当前代码事实说明，不是目标架构提案。  
> 核对日期：2026-07-23。
> 数据库 schema：version 5，名称 local-workspace-process-supervision。
> Runtime 协议版本：unified-react-plan-tool-v5。
> Context 规则版本：unified-react-context-v2。

本文从一次 HTTP 请求进入系统开始，沿着 Session、Job、Job Attempt、Context、LangChain 模型调用、ReAct 循环、Plan、工具、HITL、Checkpoint、PostgreSQL、SSE 和前端 View 一直追踪到最终回复。所有结论均以当前代码为准。

---

## 1. 一句话理解当前架构

当前系统不是 direct executor 与 plan executor 两套运行时，而是：

**一个 Session 保存长期会话；用户每发起一次任务就创建一个 Job；每个 Job 只运行一个可恢复的 ReAct 循环；Plan 是 ReAct 中的 update_plan 工具；PostgreSQL 保存业务事实和恢复边界；SSE 只负责实时投影，刷新后的 SessionView 才是权威状态。**

~~~mermaid
flowchart LR
    UI["Web UI"] -->|"HTTP command"| HTTP["NestJS HTTP"]
    HTTP --> AR["AgentRuntime"]
    AR --> JM["JobManager"]
    JM --> JES["JobExecutionSupervisor"]
    JM --> STORE["PostgresAgentStore"]
    JES --> STORE
    JES --> RER["ReactExecution"]
    RER --> AL["AgentLoop"]
    AL --> LC["LangChain ChatModel"]
    AL --> TE["ToolExecutor"]
    TE --> TOOLS["Plan / HITL / FS / Shell / Web tools"]

    RER --> STORE
    TE --> STORE
    STORE --> PG[("PostgreSQL")]

    RER --> CTX["Context pipeline"]
    CTX --> STORE

    AR --> VIEW["SessionView builder"]
    VIEW --> STORE
    HTTP --> SSE["RuntimeEventBus / SSE"]
    JM --> SSE
    RER --> SSE
    SSE --> UI
    VIEW --> UI
~~~

设计中心有四点：

1. **统一执行核**：普通问答、复杂研究、代码任务都进入同一个 ReAct。
2. **Plan 是事实，不是嵌套执行器**：PlanStep 只表达进度，不创建 StepRun 小循环。
3. **先落库，后广播**：稳定状态先在事务内提交，再通过 SSE 通知前端。
4. **恢复稳定边界，不恢复 JS 调用栈**：Checkpoint 保存循环所处阶段、计数器和工具批次，而不是序列化进程内对象。

Server 作为 composition root 创建 `JobExecutionSupervisor` 和 `JobManager`，
并只把 `JobManager` 注入 `AgentRuntime`。Job 用户用例、进程内执行调度和
数据库原子事务形成单向依赖，不再存在两个同级 Job 管理对象。

---

## 2. 核心词汇

| 概念 | 大白话 | 是否单独落表 |
| --- | --- | --- |
| Session | 一条长期会话，也是一个独立工作区 | 是 |
| Job | 用户的一轮目标；一次发送对应一个 Job | 是 |
| Job Attempt | 同一个 Job 的一次执行租约；首次运行、HITL 继续或人工恢复都会产生新的 attemptId | 否，记录在 Job 及各类事实行中 |
| Retry Job | 放弃原 Job 后创建的新 Job，可复用原始用户目标 | 是，新 Job 通过 retryOfJobId 指向旧 Job |
| ReAct iteration | 一次模型调用，以及它产生的零个或多个工具调用 | 通过 ModelCall、Message、Checkpoint 间接记录 |
| LoopCheckpoint | 可恢复的循环边界 | 是 |
| ModelCall | 一次真实发给模型的输入、输出、token 与审计记录 | 是 |
| Message | LangChain 对话事实，包括 Human、AI tool call、Tool result 和最终 AI 回复 | 是 |
| ToolInvocation | 一个 tool_call 的业务状态 | 是 |
| ToolExecutionAttempt | ToolInvocation 在某个 Job Attempt 中的一次实际执行 | 是 |
| Plan | 当前 Job 的可见计划 | 是，每个 Job 最多一个 |
| PlanStep | 计划中的进度项 | 是，但不是独立执行器 |
| UserInputRequest | 工具请求用户输入后形成的等待事实 | 是 |
| Artifact | 文件工具生成的不可变版本快照 | 是 |
| ContextSummary | 历史压缩结果 | 是 |
| SessionView | 前端刷新时取得的权威读模型 | 否，查询时构建 |
| SSE event | 已提交事实的实时增量通知，或未提交的模型文本 delta | 否 |

### 2.1 Job Attempt 不是独立业务对象

当前没有 agent_job_attempts 表。Job 只保存：

- current_attempt_id：当前或最后一次执行标识；
- attempt_no：当前已启动到第几次；
- lease_owner：哪个 worker 拥有执行权；
- lease_expires_at_ms：租约失效时间。

attemptId 还会写入 Message、ModelCall、LoopCheckpoint、ToolInvocation 和 ToolExecutionAttempt，因此可以重建一次 attempt 做过什么，但不能像查询一张 JobAttempt 表那样直接获取完整 attempt 列表。

### 2.2 Resume 与 Retry 完全不同

| 操作 | 目标 | Job ID | 用户消息 | 使用场景 |
| --- | --- | --- | --- | --- |
| Resume | 继续同一个 Job | 不变 | 不新增 | 服务中断后，从 Checkpoint 恢复 |
| Retry | 新建一个 Job | 新 ID | 默认复用原 goal，不重复写；显式传 message 时才新增 | 原 Job 已 failed 或 cancelled，希望重新做 |
| HITL answer | 回答等待中的工具请求 | 不变 | 以 ToolMessage 写入，不是普通 HumanMessage | request_user_input 后继续 |

---

## 3. 代码模块与职责边界

### 3.1 目录

~~~text
src/
  agent-loop/
    agent-loop.ts                 纯循环协议、模型流、工具批次、退出条件
    langchain-model.ts            AgentLoop 所需模型接口
    loop-events.ts                循环事件
    loop-result.ts                循环终态

  domain/
    session.ts
    job.ts
    loop-checkpoint.ts
    message.ts
    model-call.ts
    plan.ts
    tool-invocation.ts
    user-input-request.ts
    artifact.ts
    context-summary.ts
    realtime-event.ts

  orchestration/
    agent-runtime.ts              HTTP 应用入口与 Session 用例
    job-manager.ts                Job 用户命令、状态编排与 SSE
    job-execution-supervisor.ts   恢复扫描、进程内执行、心跳和 Runtime 组合
    helpers/
      job-persistence.helper.ts   AgentStore 原子命令参数与错误映射
    context-inspection.service.ts 调试查询编排

  runtime/
    execution/
      react-execution.ts          将持久化事实接入 AgentLoop
      tool-executor.ts            工具开始执行、重放、运行上下文
      helpers/
        durable-loop-execution.helper.ts 消费并持久化 LoopEvent
      types/
        react-execution.types.ts  ReAct 执行共享类型
    model/
      audited-chat-model.ts       LangChain 调用审计
    settings/
      execution-limits.ts         Job 和 ReAct 共享执行限制
    runtime-event-writer.ts       事件到事务与 SSE 的桥梁
    context/
      react-context.service.ts    唯一 Context 核心入口
      context-compiler.ts         Context 编译主链路
      helpers/                    分组、选择、预算和材料组装
      types/                      跨 Context 文件共享类型

  tools/
    plan-tools.ts
    hitl-tools.ts
    filesystem-tools.ts
    artifact-tools.ts
    shell-tool.ts
    browser-tools.ts
    basic-tools.ts

  storage/
    agent-store.ts                存储端口
    postgres/                     schema、migration、SQL、事务命令、mapper

  view/
    session-view.ts
    timeline-builder.ts
    view-contract.ts

  server/
    main.ts                       进程装配
    http/                         Nest Controller、异常映射、CORS
    runtime/                      模型、工具、SSE、系统提示词配置
    debug/                        Context preview
~~~

### 3.2 各层应该知道什么

| 层 | 应该知道 | 不应该负责 |
| --- | --- | --- |
| HTTP | DTO、状态码、SSE endpoint | ReAct、SQL、Context 选择 |
| Orchestration | Job 生命周期、后台执行、租约、恢复扫描、组合服务 | 模型分块协议、工具具体实现 |
| Runtime | ReAct 与持久化桥接、Context 构建、审计、工具执行语义 | HTTP、前端 UI |
| AgentLoop | LangChain messages、tool calls、循环退出条件 | PostgreSQL、SessionView、业务表 |
| Tools | 输入 schema 和具体能力 | Job 终态、SSE 组装 |
| Storage | 原子事务、CAS、租约 fence、查询 | 模型判断和 UI 展示 |
| View | 将已提交事实投影成读模型 | 修改执行状态 |

当前边界并非绝对纯净。例如 update_plan 工具为了及时展示会直接发布 Plan 事件；ToolExecutor 需要读取已提交 ToolResult 来做重放。这些是当前实现的实际取舍。

---

## 4. 进程启动与依赖装配

入口是 src/server/main.ts。

~~~mermaid
sequenceDiagram
    participant P as Node process
    participant ENV as dotenv / env
    participant DB as PostgreSQL
    participant PS as Local process supervisor
    participant RT as AgentRuntime
    participant JM as JobManager
    participant JES as JobExecutionSupervisor
    participant HTTP as NestJS/Fastify

    P->>ENV: 加载 .env
    P->>DB: 建立 Pool
    P->>DB: assertAgentRuntimeSchemaVersion
    Note over P,DB: 只读校验，不自动 migrate/reset
    P->>P: 创建 Store/EventBus/Model/Tools
    P->>PS: 扫描带 Runtime 身份标记的存活进程
    P->>P: 创建 Orchestrator/ContextPreview/AgentRuntime
    P->>RT: start()
    RT->>JM: start()
    JM->>JES: start()
    JES->>JES: 扫描中断 Job 并启动定时恢复检查
    P->>HTTP: 创建应用、注册 Filter/CORS
    P->>HTTP: listen(HOST, PORT)
~~~

### 4.1 模型选择

1. 如果存在 DASHSCOPE_API_KEY：
   - provider = dashscope；
   - 默认 base URL = DashScope OpenAI compatible endpoint；
   - 默认模型 = qwen-plus。
2. 否则：
   - 使用 OPENAI_API_KEY；
   - provider = openai-compatible；
   - 默认模型 = gpt-4.1-mini。
3. OPENAI_BASE_URL 和 OPENAI_MODEL 可覆盖默认值。
4. ChatOpenAI 当前 temperature = 0，streaming = true。

### 4.2 Prompt 治理如何约束统一 ReAct

`JOB_AGENT_SYSTEM_PROMPT` 是稳定的跨工具执行策略，不再重复每个工具的局部说明：

- 简单、本地、单动作请求直接回答，不创建 Plan；
- 多步骤、研究加综合、多 Artifact 或需要检查点的任务先调用 update_plan；
- 有 pending/in_progress Step 时禁止 final；
- 搜索摘要只用于发现，依赖来源的结论必须打开网页验证；
- 同一模型响应中的工具是 siblings，不能假设后一个看到前一个结果；
- 搜索/读取与写入不能放在同一个工具批次；
- final 只能陈述实际存在的 durable outcome 与 Artifact。

`update_plan` 的完整计划、稳定 Step key、唯一 `in_progress` 等局部规则由工具 Schema 描述并由 Runtime 校验；`write_file`、`write_article`、`run_shell`、`start_process` 的适用范围同样由各自工具契约负责。Runtime 拒绝非法输出时使用带错误码的内部 `SystemMessage`，不会伪装成用户消息。

正式输入还包含一段稳定环境信息，描述 Session workspace、`code/docs/artifacts/downloads/tmp` 目录、平台、Shell 和时区。当前时间不放入稳定前缀，避免每轮破坏 Provider 缓存。

Prompt 版本 `job-agent-v6` 以及以下组件会进入 ModelCall manifest：

- `job-agent-policy`：稳定；
- `job-agent-environment`：Session 内稳定；
- `durable-runtime-state`：动态。

每个组件都记录版本、cacheScope、checksum 和 estimatedTokens。完整 Prompt checksum 用于比较两次调用是否遵循相同输入协议；历史 ModelCall 的精确预览依赖持久化 `inputMessages + inputChecksum`，不要求当前部署仍使用相同 Prompt。

### 4.3 主要环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| DATABASE_URL | 必填 | PostgreSQL |
| DASHSCOPE_API_KEY | 无 | 优先使用 DashScope |
| OPENAI_API_KEY | 无 | OpenAI-compatible key |
| OPENAI_BASE_URL | provider 默认值 | 自定义兼容接口 |
| OPENAI_MODEL | qwen-plus 或 gpt-4.1-mini | 模型名 |
| AGENT_SERVER_HOST | 127.0.0.1 | Runtime HTTP 监听地址 |
| AGENT_SERVER_PORT | 3000 | Runtime HTTP 监听端口 |
| AGENT_RUNTIME_WORKER_ID | worker_进程号 | 租约 owner |
| AGENT_SANDBOX_ROOT | .agent-sandbox | Session 工作区根 |
| JOB_LEASE_MS | 30000 | Job 租约时长 |
| JOB_HEARTBEAT_MS | 约租约三分之一，最少 1000 | 心跳间隔 |
| JOB_RECOVERY_SCAN_MS | 5000 | 过期 Job 扫描 |
| MODEL_CONTEXT_WINDOW_TOKENS | 按模型能力表 | 覆盖模型上下文窗口 |
| MODEL_OUTPUT_TOKEN_LIMIT | 4096 | 覆盖单次输出上限，并传给 LangChain `maxTokens` |
| MODEL_INPUT_TOKEN_LIMIT | `context - output` | 覆盖输入硬上限 |
JOB_HEARTBEAT_MS 必须短于 JOB_LEASE_MS，否则启动直接失败。

### 4.4 关闭

SIGINT 或 SIGTERM 时：

1. AgentRuntime.stop 委托 JobManager.shutdown；
2. JobManager 委托 JobExecutionSupervisor 关闭恢复扫描并 abort 所有本进程执行；
3. ManagedProcessManager 关闭本地发现轮询，但不终止独立开发服务；
4. 等待活动 Promise 收敛；
5. 关闭 HTTP；
6. 关闭数据库 Pool。

Runtime 被强杀时不会执行以上清理。Job 恢复依赖租约过期与人工 Resume；已启动的独立开发服务继续运行，新 Runtime 通过命令行身份标记与本地 ownership token 重新发现它。

---

## 5. HTTP 命令面

| Method | Path | 作用 |
| --- | --- | --- |
| POST | /sessions | 创建 Session |
| GET | /sessions | 列出 Session |
| GET | /sessions/:sessionId/view | 获取权威 SessionView |
| DELETE | /sessions/:sessionId | 删除数据库事实并移除工作区 |
| POST | /sessions/:sessionId/jobs | 创建 Job 与本轮 HumanMessage |
| POST | /jobs/:jobId/cancel | 取消 Job |
| POST | /jobs/:jobId/retry | 从 failed/cancelled Job 创建新 Job |
| POST | /jobs/:jobId/resume | 人工恢复 recovery_required Job |
| POST | /user-input-requests/:requestId/answer | 回答 HITL |
| GET | /sessions/:sessionId/context-preview | 预览下一轮正式 Context |
| GET | /jobs/:jobId/context-preview | 预览指定 Job Context |
| GET | /model-calls/:modelCallId/context | 重建并校验某次模型输入 |
| GET SSE | /sessions/:sessionId/events | 实时事件流 |

创建 Job 的 clientRequestId、回答输入的 clientAnswerId 都是客户端生成的 UUID，用于请求幂等。

异常映射：

- TypeError、RangeError → 400；
- Store not found → 404；
- Store conflict/already、Runtime concurrency/idempotency conflict → 409；
- 其他 StoreError 与 invalid_job_state → 422；
- 未显式映射的 RuntimeError → 500。

---

## 6. Session、Job 与消息的创建

### 6.1 普通发送

~~~mermaid
sequenceDiagram
    participant UI as Frontend
    participant HTTP as AgentController
    participant AR as AgentRuntime
    participant JM as JobManager
    participant DB as PostgreSQL
    participant BG as JobExecutionSupervisor

    UI->>HTTP: POST /sessions/:id/jobs
    HTTP->>AR: createJob
    AR->>JM: createJob
    JM->>DB: 单事务创建 Job + HumanMessage
    DB-->>JM: createdJob, userMessage
    JM->>DB: attemptNo + 1, 设置租约, 写 ready_for_model checkpoint
    DB-->>JM: running Job
    JM->>BG: 后台 startExecution
    AR-->>UI: running Job + Message
~~~

数据库事务同时写 Job 和 HumanMessage，避免出现“有 Job 没有目标消息”或“有消息没有 Job”。

Job metadata 保存 goalMessageId。后续 Retry、Context 和 Plan goal 都从这一稳定引用解析原始目标，而不是猜“最后一条用户消息”。

### 6.2 clientRequestId 幂等

同一 Session 再次提交同一个 clientRequestId：

- 内容一致、retry 来源一致：返回已存在的 Job，不重复写 Message；
- 内容或来源不同：抛 idempotency conflict；
- 数据库唯一索引为 session_id + client_request_id。

### 6.3 同一 Session 只能有一个活跃 Job

活跃状态包括 created、running、waiting_user_input、resuming、recovery_required。

数据库 partial unique index 从根上阻止同一 Session 同时存在两个活跃 Job。

---

## 7. Job 状态机

~~~mermaid
stateDiagram-v2
    [*] --> created
    created --> running: 首次 start
    created --> recovery_required: 创建后未成功启动且超期
    created --> cancelled

    running --> waiting_user_input: HITL
    running --> recovery_required: 租约过期
    running --> completed: 最终回复提交
    running --> failed
    running --> cancelled

    waiting_user_input --> resuming: 用户回答
    waiting_user_input --> cancelled

    resuming --> recovery_required: 租约过期
    resuming --> completed
    resuming --> failed
    resuming --> cancelled

    recovery_required --> running: 用户点击 Resume
    recovery_required --> cancelled

    completed --> [*]
    failed --> [*]
    cancelled --> [*]
~~~

注意：领域文件定义了 resuming → running，但当前 HITL 实际执行过程中 Job 可以一直保持 resuming，随后直接 completed/failed。租约与存储命令允许这种路径。

### 7.1 版本与执行 fence

每个 Job 有 version。来自前端的取消与恢复都带 expectedVersion。

执行侧的关键写入还会校验 lease_owner、current_attempt_id、lease_expires_at_ms，必要时校验 Job version。即使旧进程晚到一步，它也不能用过期租约覆盖新 attempt 的结果。

---

## 8. JobExecutionSupervisor：进程内执行调度

该类不实现 ReAct 细节，负责：

1. 保证同一进程内同一 Job 只运行一个 Promise；
2. 创建 AbortController；
3. 定时续租；
4. 验证 Job 状态、worker、attempt 和租约；
5. 读取稳定 goal；
6. 组合 ReactExecution；
7. 将未被底层处理的异常转成 Job failed；
8. 扫描因进程退出而中断的 Job，并标记为 recovery_required；
9. 服务关闭时停止扫描、等待当前扫描结束并中止活动执行。

默认执行限制：

| 限制 | 默认 |
| --- | --- |
| maxIterations | 24 |
| maxToolCalls | 48 |
| executionDeadline | 15 分钟 |
| lease | 30 秒 |
| heartbeat | 10 秒左右 |

当前 deadline 是以 Job.startedAtMs 加 15 分钟计算，而不是以每个恢复 attempt 的开始时间重新计算。因此一个很久以后才 Resume 的 Job 可能一恢复就超时。这是当前实现边界。

心跳续租失败不会立刻在定时器里抛出；下一次需要 fence 的数据库写入会发现租约已经丢失。

---

## 9. ReactExecution：持久化事实接入 ReAct

每次 execute 前先读取最新 LoopCheckpoint。

### 9.1 两种入口

1. ready_for_model 或没有未完成工具批次：
   - 构建 Job Context；
   - 发起下一次模型调用。
2. tool_batch：
   - 找到 call_message_id 对应的工具批次；
   - 只加载 status = pending 的 invocation；
   - 先执行剩余工具；
   - 批次完成后才重新构建 Context 并调用模型。

### 9.2 每轮都会重新加载 Context

AgentLoop 的 prepareMessages 不是只在 Job 开始时调用一次。每次模型调用前都会从数据库重新加载，因为上一轮 ToolMessage、Plan、HITL 回答或 ContextSummary 都可能刚刚变化。

### 9.3 Plan 最终约束

模型没有 tool call、准备输出 final 时，Runtime 会检查：

- 当前 Job 没有 Plan：可以结束；
- Plan = completed：可以结束；
- Plan = active：拒绝这份草稿，要求模型调用 update_plan 完成或修正计划；
- Plan = failed/cancelled：Job 失败，不能把貌似完成的文字当成功。

被拒绝的流式草稿不会成为正式 Message，前端收到 message.discarded 后移除它。

---

## 10. AgentLoop 算法

AgentLoop 只认识 BaseMessage、LangChain 可流式模型、RuntimeTool、循环事件和执行限制。它不知道 PostgreSQL、SessionView、NestJS。

### 10.1 伪代码

~~~text
for iteration from checkpoint.iterationNo to maxIterations:
  assert not aborted
  assert deadline not exceeded

  messages = await prepareMessages()
  messages += transient correction messages

  stream model(messages)
  emit model.output.delta for every text chunk
  assemble AIMessageChunk and tool calls

  if no tool calls:
    reject empty response
    validate final against active Plan
    if rejected:
      emit model.output.rejected
      append transient correction messages
      continue
    emit model.output.completed
    return completed

  validate tool arguments and batch rules
  if rejected:
    discard draft
    append correction messages
    continue

  emit model.output.completed with tool calls
  await consumer persist call message + invocations + checkpoint

  for call in tool calls, in model order:
    execute one tool
    emit stable result
    await consumer persist result before next tool

  if any tool requests user input:
    persist completed siblings first
    emit input-required events
    return waiting

return max_iterations failure
~~~

### 10.2 工具是串行执行

一个模型响应里即使有 5 个 tool calls，当前也按照模型给出的顺序串行执行：

~~~text
call 1 -> 结果落库 -> call 2 -> 结果落库 -> ... -> call 5
~~~

收益是顺序稳定、后一个工具不越过前一个结果、崩溃时可精确识别剩余工具、HITL 更容易收敛。

### 10.3 批次规则

- exclusive 工具必须是该模型轮次中唯一工具；
- requiresFreshContext 工具不能与需要先完成的非 fresh 工具放在同一批次；
- maxToolCalls 在执行整个新批次前检查，不能部分越界；
- tool call 参数必须能组装成合法 JSON；
- invalid_tool_args 形成失败 ToolResult，循环可继续；
- LangChain tool chunk 自相矛盾导致组装冲突时，循环失败。

当前 update_plan 与 run_shell 是 exclusive。

### 10.4 退出标志

成功退出必须同时满足：模型本轮无 tool call、文本非空、final validator 接受、最终 Message 与 Job completed 同事务提交。

其他退出包括 waiting_user_input、用户取消、runtime shutdown、deadline、maxIterations、maxToolCalls、model error、context error、invalid plan state 和 lease conflict。

---

## 11. 模型流、审计与正式消息

### 11.1 AuditedChatModel

模型调用前：

1. 将真实 LangChain BaseMessage 转成可存储结构；
2. 生成 canonical JSON；
3. 计算 SHA-256 input_checksum；
4. 写 agent_model_calls，status = started；
5. 保存 input_manifest、input_messages、模型名、provider、预算；
6. 再调用底层 ChatModel。

调用完成后保存 result、tool names、token usage、cache usage、终态、outputId 和 output disposition。

### 11.2 delta 不是正式 Message

~~~mermaid
sequenceDiagram
    participant M as Model
    participant AL as AgentLoop
    participant W as RuntimeEventWriter
    participant SSE as SSE
    participant DB as PostgreSQL
    participant UI as Frontend

    M-->>AL: text chunk
    AL-->>W: model.output.delta
    W-->>SSE: message.delta
    SSE-->>UI: 临时累加

    alt 最终回复被接受
        AL-->>W: model.output.completed
        W->>DB: Final Message + Job completed + checkpoint
        DB-->>W: commit
        W-->>SSE: message.upserted + job.upserted
        SSE-->>UI: 正式 Message 替换 delta
    else 草稿被拒绝
        AL-->>W: model.output.rejected
        W->>DB: ModelCall disposition = rejected
        W-->>SSE: message.discarded
        SSE-->>UI: 删除 delta
    end
~~~

服务在流式输出中途退出时，用户看到过的 delta 可能消失，刷新后不会出现半条 AssistantMessage；Resume 从最后稳定 Checkpoint 重新调用模型。

### 11.3 tool call 什么时候能识别

模型流式生成 tool_calls.args 时，LangChain AIMessageChunk 持续合并碎片。当前 Runtime 只有在该轮模型流完成、参数组装成功后，才提交 tool_call Message 和 ToolInvocation。

因此 write_file 的 content 参数不会像编辑器那样逐字符成为文件 delta。当前 UI 只能先显示模型文本 delta，随后显示正式工具卡片。

---

## 12. RuntimeEventWriter：从循环事件到事务

`executeDurableAgentLoop` 逐个消费 AgentLoop 事件。每处理完并持久化一个事件，才向 generator 请求下一个，形成自然背压。

| Loop 事件 | 稳定写入 | SSE |
| --- | --- | --- |
| model.output.delta | 不落 Message | message.delta |
| model.output.rejected | ModelCall disposition = rejected | message.discarded |
| model.output.completed + tool calls | call Message + pending Invocations + tool_batch Checkpoint | message.upserted、tool_invocation.upserted |
| tool.result | result Message + Invocation + ToolExecutionAttempt + Artifact + 可选 ready Checkpoint | message/tool/artifact upsert |
| user.input.required | InputRequest + Invocation waiting + Job waiting + Checkpoint | input/tool/job upsert |
| final accepted | final Message + Job completed + completed Checkpoint | message/job upsert |
| failure | Job failed + 子对象终止 + failed Checkpoint | job/plan/step/tool/input upsert |

广播发生在数据库 commit 之后。广播失败不会回滚数据库，刷新 SessionView 可恢复正确状态。

敏感工具参数可以通过 sensitiveArgumentPaths 在持久化前脱敏；arguments_checksum 仍基于原始参数，用于一致性校验。

---

## 13. 工具执行链路

~~~mermaid
sequenceDiagram
    participant AL as AgentLoop
    participant W as RuntimeEventWriter
    participant DB as PostgreSQL
    participant TE as ToolExecutor
    participant T as LangChain Tool

    AL->>W: tool calls assembled
    W->>DB: call Message + pending Invocations + tool_batch Checkpoint
    DB-->>W: committed

    AL->>TE: execute tool call
    TE->>DB: tryStartToolExecution
    DB->>DB: pending -> running, create execution attempt

    alt 已有稳定终态
        DB-->>TE: terminal replay
        TE->>DB: load committed ToolResult
    else 首次执行
        TE->>T: invoke(args, agentRuntimeContext)
        T-->>TE: result / HITL / error
    end

    TE-->>AL: stable result
    AL->>W: persist result
    W->>DB: ToolMessage + Invocation terminal + Attempt terminal + Artifacts
    DB->>DB: 若批次全终态，append ready_for_model Checkpoint
~~~

### 13.1 注入给工具的运行上下文

每个工具调用可以获得 sessionId、jobId、sandboxRoot、attemptId、invocationId、toolCallId、idempotencyKey 和 AbortSignal。

### 13.2 三种副作用等级

| level | 含义 | 中断恢复 |
| --- | --- | --- |
| read_only | 不改变外部状态 | 可重置 pending 后重跑 |
| idempotent | 可凭幂等键安全重复 | 可重置 pending 后重跑 |
| side_effecting | 可能产生不可逆或无法判定的外部效果 | running 中断后转 unknown，不自动重跑 |

Runtime 每次执行前会比对持久化的 toolName、argumentsChecksum 和 sideEffectLevel，防止代码升级后拿旧 invocation 执行成另一种行为。

### 13.3 当前工具

| 工具 | 副作用 | 特殊约束 | 作用 |
| --- | --- | --- | --- |
| update_plan | idempotent | exclusive | 创建/更新 Plan |
| request_user_input | read_only | 无 | HITL |
| get_current_time | read_only | 无 | 当前时间 |
| calculate | read_only | 无 | 计算 |
| list_files/read_file/grep_files/list_symbols | read_only | 无 | 文件读取与检索 |
| write_file | idempotent | requiresFreshContext | 写文件并登记 Artifact |
| write_article | idempotent | requiresFreshContext | 写文档 Artifact |
| run_shell | side_effecting | exclusive、requiresFreshContext | 执行宿主 Shell |
| start_process | side_effecting | exclusive、requiresFreshContext | 启动并监管常驻开发服务 |
| get_process/read_process_logs | read_only | 无 | 查询本机实时进程状态与 workspace 日志 |
| stop_process | idempotent | exclusive、requiresFreshContext | 按 processId 安全停止常驻服务 |
| browse_url/web_search | read_only | 无 | 网页读取与搜索 |

### 13.4 文件与 Shell 权限边界

文件工具只允许 Session workspace，做路径归一化与 symlink 穿越防护，并生成 revision snapshot。

当前工作区中的 run_shell 被明确配置为：

- 可访问宿主网络；
- 可读写宿主文件系统；
- 继承普通宿主环境变量，但移除 Runtime 的数据库/API Key、AGENT_RUNTIME_*、AGENT_SERVER_* 以及容易污染应用端口的 HOST/PORT；
- 不使用 OS sandbox；
- 默认超时 5 分钟，最大 30 分钟；
- stdout、stderr 各截断到约 32 KB；
- 取消时终止进程组；
- 非零退出与超时返回稳定 ToolExecutionError。

因此 sandboxRoot 只是默认 cwd 所在的 Session 工作区，不是 run_shell 的安全沙箱。

常驻服务不由 run_shell 等待。start_process 会在 Session workspace 中写入权限为 0600 的本地启动 spec，创建带 processId、sessionId、ownershipToken 命令行标记的独立 supervisor/进程组，默认从 4100-4999 选择空闲端口，显式注入应用自己的 HOST/PORT，并在 TCP 端口可连接后才返回 running。

PID、进程组、端口与 liveness 不进入 PostgreSQL。Runtime 内存 registry 是当前进程内的实时视图；Runtime 重启后扫描 `ps`，只有命令行标记与 Session workspace 内本地 spec 的 ownershipToken 同时匹配才会接管展示和停止能力。停止前会再次核验身份，避免对 PID 复用后的无关进程发送信号。工具调用及 ToolResult 仍按普通工具协议持久化，因此业务审计不依赖本地进程表。

---

## 14. Plan 是工具，不是第二套执行器

### 14.1 创建与更新

模型在同一个 ReAct 中调用 update_plan，提交完整 Plan。第一次提交如果全是 pending，Runtime 自动把第一步提升为 in_progress。

### 14.2 不变量

- 每个 Job 最多一个 Plan；
- step key 与 durable ID 稳定；
- 已存在 step 不能在后续全量更新中被省略；
- terminal step 不能回退；
- 同一时间最多一个 in_progress；
- PlanStep 顺序由 position 稳定；
- 模型只负责 result.summary；
- evidenceMessageIds 与 artifactIds 由 Runtime 追加；
- Plan status 由 Step 状态推导；
- 重复调用可按 lastToolCallId 幂等返回。

### 14.3 PlanStep 如何和工具结果关联

Tool call 落库时，Storage 查找该 Job 当前 active Plan 和唯一 in_progress Step，并自动将 call Message、ToolInvocation、result Message 和 Artifact 挂到同一个 planId、planStepId。

成功的非 update_plan 工具完成后，Runtime 将结果 Message ID 与 Artifact ID 加进当前 Step.result 的证据字段。

### 14.4 完整时序

~~~mermaid
flowchart TD
    A["模型调用 update_plan"] --> B["创建 Plan 与 PlanSteps"]
    B --> C["模型调用检索/文件/代码工具"]
    C --> D["工具事实自动挂到当前 in_progress Step"]
    D --> E["模型再次 update_plan，完成当前 Step 并推进下一 Step"]
    E --> F{"还有未完成 Step？"}
    F -->|有| C
    F -->|没有| G["Plan = completed"]
    G --> H["模型输出 final"]
    H --> I["Final validator 接受"]
~~~

没有 StepExecutor、StepRun、嵌套 Context 或 PlanFinalizer。“执行下一步”只是同一个 ReAct 看到了更新后的 Plan 与工具历史，继续决定下一次 action。

---

## 15. HITL：请求用户输入

~~~mermaid
sequenceDiagram
    participant M as Model/ReAct
    participant T as request_user_input
    participant DB as PostgreSQL
    participant UI as Frontend
    participant AR as AgentRuntime

    M->>T: 请求用户选择/填写
    T-->>M: input-required
    M->>DB: 已完成 sibling 工具结果
    M->>DB: InputRequest pending + Invocation waiting + Job waiting + Checkpoint
    DB-->>UI: SSE upserts

    UI->>AR: POST answer
    AR->>DB: 原子写 answer ToolMessage
    DB->>DB: Request answered, Invocation completed
    DB->>DB: Job resuming, 新 attempt + lease + ready checkpoint
    AR->>M: 后台继续同一个 Job
~~~

工具来源的 HITL 固定 source = tool、answerMode = as_tool_result。答案以 ToolMessage 回到原 tool_call，不会额外插入普通 HumanMessage；clientAnswerId 防止重复提交。

公开 SessionView 会对 HITL answer、clientAnswerId 和 Invocation result 做脱敏。

---

## 16. 取消、失败、Retry 与 Resume

### 16.1 Cancel

取消采用“先持久化终态，再 abort 内存执行”：

1. Store 将 Job 与未完成子对象终止；
2. 写 cancelled Checkpoint；
3. 提交；
4. AgentRuntime abort 当前执行；
5. 发布 upsert。

旧执行后续的持久化会被 lease/version fence 拒绝。

### 16.2 Retry

只允许 failed 或 cancelled Job：

- 创建全新 Job；
- retryOfJobId 指向旧 Job；
- 默认复用旧 Job goalMessageId；
- 不重复插入原 HumanMessage；
- 显式提供新 message 时才写新 HumanMessage；
- 新 Job 从 iteration 0 开始，不复用旧 Checkpoint。

### 16.3 recovery_required

`JobExecutionSupervisor` 启动后立即扫描一次，之后定时扫描：

1. abandon 已失去有效 lease 的 started ModelCall；
2. 找 created 且长时间未启动的 Job；
3. 找 running/resuming 且 lease 过期的 Job；
4. 标记 recovery_required 并广播；
5. **不自动继续执行**。

### 16.4 Resume

~~~mermaid
flowchart TD
    A["发现过期 Job"] --> B["标记 recovery_required"]
    B --> C["前端展示继续任务"]
    C --> D["用户点击 Resume"]
    D --> E["CAS 校验 expectedVersion"]
    E --> F["创建新 attempt 与租约"]
    F --> G["读取最新 Checkpoint"]
    G --> H["prepareToolInvocationsForRecovery"]
    H --> I{"存在 running side_effecting？"}
    I -->|是| J["Invocation = unknown"]
    J --> K["Job failed: unsafe_tool_recovery"]
    I -->|否| L["安全 invocation 重置 pending"]
    L --> M["从 Checkpoint 恢复 ReAct"]
~~~

---

## 17. Checkpoint 与崩溃恢复

### 17.1 Checkpoint 阶段

| phase | 含义 | callMessageId |
| --- | --- | --- |
| ready_for_model | 下一步应调用模型 | 无 |
| tool_batch | tool call Message 已提交，批次尚未结束 | 有 |
| waiting_user_input | 等待某批次里的 HITL | 有 |
| completed | Job 成功终止 | 无 |
| failed | Job 失败终止 | 无 |
| cancelled | Job 取消终止 | 无 |

每条 Checkpoint append-only，包含 sequenceNo、attemptId、iterationNo、executedToolCalls、metadata 和可选 callMessageId。

### 17.2 不保存整个 AgentLoop

Checkpoint 不保存 JS generator 栈、provider socket、未落库 delta、工具局部变量和 transient correction messages。它保存的是“下一次从哪个稳定动作继续”。

### 17.3 五工具串行示例

~~~text
checkpoint tool_batch(iteration=3, executedToolCalls=5)
A completed
B completed
C running       <- 此时进程退出
D pending
E pending
~~~

Resume 后：

1. 不重复增加 iteration 或 executedToolCalls，整个批次提交时已计数；
2. A、B 从已提交 ToolResult 重放，不重新执行；
3. C 若 read_only/idempotent，旧 attempt = interrupted，Invocation = pending；
4. C 若 side_effecting，Invocation = unknown，阻止自动重跑；
5. D、E 保持 pending；
6. 无 unknown 时按 C、D、E 原顺序继续；
7. 批次全终态后写 ready_for_model；
8. Context 加入完整工具交换，再调用模型。

### 17.4 崩溃位置矩阵

| 崩溃位置 | 已持久化 | Resume 行为 |
| --- | --- | --- |
| Job 尚未成功启动 | created Job | 扫描转 recovery_required，人工 Resume |
| 模型流式输出中 | ModelCall started，可能有 UI delta | delta 丢弃，旧 call abandon，重新调用模型 |
| tool calls 事务前 | ModelCall result，无 call Message | 从 ready_for_model 重新调用模型 |
| pending Invocations 已提交 | tool_batch Checkpoint | 继续 pending 批次 |
| read-only/idempotent 工具 running | execution attempt running | interrupted，重置 pending，重跑 |
| side-effecting 工具 running | 外部结果未知 | unknown，Resume 失败 |
| 部分工具结果已提交 | completed/failed Invocations | 已提交不重跑，只继续剩余 |
| Final 事务后 | 完整终态 | 无需恢复 |

### 17.5 当前恢复限制

1. idempotencyKey 会传给工具，但标记 idempotent 的工具作者必须真正实现幂等。
2. run_shell 是 side_effecting，中断后不会盲目重放。
3. 当前没有人工 reconcile unknown 工具后继续的 API。
4. transient correction messages 崩溃后不恢复；旧 ModelCall 精确输入仍可审计。
5. checkpoint 不提供 JS 栈恢复或图式 time travel。

---

## 18. Context 全链路

### 18.1 总流程

~~~mermaid
flowchart LR
    DB[("Messages / Jobs / Summaries")] --> RCS["ReActContextService"]
    RCS --> MGB["MessageGroupBuilder"]
    MGB --> TB["TurnBundleBuilder"]
    TB --> MAT["唯一 ContextMaterial"]
    MAT --> CC["ContextCompiler"]
    CC --> BUD["TokenBudget"]
    BUD --> LC["LangChain BaseMessage[]"]

    CC -->|"建议压缩"| RCS
    RCS --> CM["Audited context.compress call"]
    CM --> SCS["ContextCompressionService"]
    SCS --> DB
    RCS -->|"重新加载事实"| DB
~~~

### 18.2 ReActContextService

这是正式执行链唯一公开的 Context 入口。每次 ReAct 模型调用前，
`buildForJob(job, originalGoal)` 会读取 Session 下所有 Jobs、Messages、
ToolInvocations 和 active ContextSummary，并在需要时完成
compile → compress → reload。

Session 事实读取是该服务的内部步骤，不再暴露成另一种 “Session Context”。
它不会把每一行简单按时间拼起来，而是先构造合法消息组。

### 18.3 MessageGroupBuilder

两类 group：

1. standalone：普通 HumanMessage、最终 AIMessage 等；
2. tool_exchange：一条 AI tool_call + 所有对应 ToolMessages。

一个 tool_exchange 只有在以下条件满足时才完整：

- 每个 ToolCall 都能找到 ToolInvocation；
- Invocation 是 completed 或 failed；
- 每个 Invocation 都有匹配 toolCallId 与 toolName 的 result Message。

不完整工具交换不会喂给模型，因为 LangChain/OpenAI 要求 AI tool_calls 与 ToolMessages 成对。

- 不完整组属于当前 Job：Context build 失败，防止模型看到非法协议；
- 不完整组只属于历史 Job：从 Context 排除并记 diagnostics。

### 18.4 TurnBundleBuilder

MessageGroup 是压缩和精确覆盖的最小单元。TurnBundle 用于表达用户轮次、Retry lineage 和预算阶段的连续历史尾；Retry 链会合并为同一个 TurnBundle：

~~~text
root Job
  retry Job 1
    retry Job 2
~~~

这样预算裁剪不会只留下 Retry 的错误卡片，却丢掉原始用户目标。摘要覆盖不再按整个 Bundle 或 Row 范围推断，而是记录稳定 `groupId`。

每个 Bundle 包含 bundleId、rootJobId、jobIds、groups、rowIdStart/rowIdEnd、terminal、estimatedTokens、priority 和 mustKeep。

### 18.5 ReActContextService 选择规则

正式 Job Context 由以下部分构成：

1. 固定 SystemMessage；
2. 工具 schemas；
3. 统一的 active Context Memory；
4. 未被 `coveredGroupIds` 精确覆盖的完整 MessageGroups；
5. 当前 Job 最近的原始 ReAct 尾部；
6. 原始 goal Message；
7. 从 Plan、PlanStep、Artifact、HITL 表读取的 Durable Runtime State。

优先级：

- 当前 Job Bundle 在预算选择阶段：mustKeep，priority 1000；
- goal：mustKeep，必须保留；
- active Context Memory：priority 60；
- 普通历史 Bundle：priority 40。

当前 Job Bundle 是选择保护，不是压缩边界。Bundle 内离开 Protected Window 的稳定旧 Group 可以被 Context Memory 覆盖。Plan 既以 `update_plan` Tool exchange 保留历史语义，也以权威 Durable Runtime State 表达当前状态。

### 18.6 Token 预算

~~~text
inputTokenLimit = configuredInputLimit ?? (contextWindowTokens - outputTokenLimit)
shouldCompress = predictedAllInputTokens >= inputTokenLimit * 0.55
mustCompress   = predictedAllInputTokens >= inputTokenLimit * 0.75
~~~

`predictedAllInputTokens` 先使用 CJK-aware estimator，再使用同一
provider/model 最近调用的 P95 误差校准。构建过程：

1. 加载全部候选输入，包括 SystemMessage、tool schemas、Context Memory 和完整 Bundle；
2. 预测全部候选输入 Token，所有压缩判断只与 `inputTokenLimit` 比较；
3. 低于 55% 时直接构建完整 Context；
4. 55% 到 75% 时尝试压缩；压缩失败仍可使用完整输入，因为它远离硬上限；
5. 达到 75% 时必须压缩到阈值以下；无候选、失败或四批后仍超阈值均抛出 `context_overflow`；
6. 禁止通过独立的 90% 选择线静默丢弃历史；
7. 生成 manifest 与 token breakdown。

Provider 若以 `finish_reason=length` 结束输出，Runtime 会丢弃该轮流式草稿并以
`model_output_truncated` 结束 Job，禁止把截断正文或不完整 ToolCall 当成成功结果。

### 18.7 ToolResult 投影

很大的 ToolResult 不一定原样放入模型：

- 单个结果上限约 8000 估算 tokens；
- 按约 60%/40% 的比例保留头尾；
- 中间替换为截断标记；
- manifest 记录被截断 Message ID 与 checksum。

保留字符数通过二分查找并重复估算，不再使用不适合中文的 `maxTokens * 4`。

数据库原始 ToolResult 不变，裁剪只发生在 Context 投影。

### 18.8 压缩

压缩由 `predictedCandidateTokens / hardInputLimit` 的压力等级触发，不再使用消息条数。默认 55% 进入 compact、75% mandatory、90% critical。

可压缩范围是所有已完成、已落库、未覆盖、未受保护且离开最近 24K Token 原文窗口的 MessageGroups；当前 Job 内稳定的旧 Group 与跨 Job 历史遵循同一规则。

压缩本身也是 Audited ModelCall，`callType=context.compress`。模型只生成 Memory 的语义字段；`coveredGroupIds/messageIds` 由 Runtime 根据事实生成。旧 active Memory 与新 Blocks 一起提供给模型，形成累计更新。

新 Memory 成功后原子 supersede 旧版本，再重新加载并编译 Context。compact 压力下压缩失败允许使用已通过预算的 Context；mandatory/critical 下禁止静默降级。

### 18.9 一份含普通对话与 Plan 的完整示例

~~~text
SystemMessage
  Runtime system prompt

HumanMessage
  用户：你好，你能做什么？

AIMessage
  普通最终回答

HumanMessage
  用户：调查萧山机场 UFO 事件并写报告

AIMessage
  tool_calls:
    update_plan({title, steps})

ToolMessage
  update_plan result: plan active, step search in_progress

AIMessage
  tool_calls:
    web_search({query})

ToolMessage
  web_search result

AIMessage
  tool_calls:
    update_plan({search completed, analyze in_progress, ...})

ToolMessage
  update_plan result

AIMessage
  tool_calls:
    write_article(...)

ToolMessage
  write_article result + artifact metadata

AIMessage
  tool_calls:
    update_plan({all steps completed})

ToolMessage
  update_plan result: plan completed

AIMessage
  最终报告说明与资源链接
~~~

每一次模型调用看到的是预算允许范围内、协议完整的上述消息前缀，而不是 PlanStep 自己另起一套小 Context。

---

## 19. Context 调试与重建

### 19.1 next_turn preview

GET /sessions/:id/context-preview：

- 只有 Session 没有活跃 Job 时可调用；
- 活跃包括 recovery_required；
- 使用正式 loader 和 compiler；
- 不伪造一条尚未发送的 HumanMessage；
- 输出精简 LangChain message JSON、来源注解和 manifest。

### 19.2 job preview

GET /jobs/:id/context-preview 按当前规则加载指定 Job，用于判断“如果现在发起下一次模型调用，会看到什么”。

### 19.3 model_call context

GET /model-calls/:id/context：

1. 读取 ModelCall 当时保存的 inputMessages；
2. 根据 inputManifest 校验引用的 group、summary、bundle、规则版本和 checksum；
3. 只有材料仍可重建且一致时才返回；
4. 不匹配时显式失败，不伪装为可验证。

这使 ModelCall 成为“模型当时到底看见了什么”的审计证据。

---

## 20. PostgreSQL 数据模型

### 20.1 ER 图

~~~mermaid
erDiagram
    SESSION ||--o{ JOB : contains
    JOB ||--o| PLAN : owns
    PLAN ||--o{ PLAN_STEP : contains
    JOB ||--o{ MESSAGE : writes
    PLAN_STEP o|--o{ MESSAGE : scopes
    MESSAGE ||--o{ TOOL_INVOCATION : calls
    TOOL_INVOCATION o|--|| MESSAGE : result
    TOOL_INVOCATION ||--o{ TOOL_EXECUTION_ATTEMPT : executes
    TOOL_INVOCATION ||--o{ ARTIFACT : produces
    TOOL_INVOCATION o|--o| USER_INPUT_REQUEST : waits
    JOB ||--o{ MODEL_CALL : audits
    JOB ||--o{ LOOP_CHECKPOINT : checkpoints
    SESSION ||--o{ CONTEXT_SUMMARY : compresses
    SESSION ||--o| MODEL_USAGE_STATS : aggregates
~~~

### 20.2 表清单

#### agent_schema_versions

保存每次已应用 schema 的 version、name、checksum、appliedAtMs。启动只检查代码 version 3 与数据库最新版本完全一致。

#### agent_sessions

| 关键字段 | 说明 |
| --- | --- |
| id | session_xxx |
| title | 可空 |
| status | active/archived |
| version | 乐观版本 |
| created_at_ms/updated_at_ms | 时间 |

#### agent_jobs

| 关键字段 | 说明 |
| --- | --- |
| session_id | 所属 Session |
| retry_of_job_id | Retry 来源 |
| client_request_id | 创建幂等键 |
| status | 8 种 Job 状态 |
| current_attempt_id/attempt_no | 当前执行 attempt |
| lease_owner/lease_expires_at_ms | 分布式执行权 |
| error_code/message/details | 终态错误 |
| metadata | 含 goalMessageId 等 |
| started_at_ms/completed_at_ms | 生命周期 |

关键约束：

- 同一 Session 仅一个 active Job；
- session + clientRequestId 唯一；
- running/resuming 必须有 lease；
- terminal 必须有 completedAtMs。

#### agent_plans

- job_id unique：一个 Job 最多一个 Plan；
- title、goal、status、version；
- completed_at_ms；
- Session 删除级联。

#### agent_plan_steps

- plan_id + key 唯一；
- plan_id + position 唯一；
- status；
- result 必须是 JSON object；
- error、version、completedAtMs。

#### agent_messages

| 字段 | 作用 |
| --- | --- |
| row_id | bigserial，全局权威时间顺序 |
| id | 业务 ID |
| session_id/job_id | 归属 |
| plan_id/plan_step_id | 可选进度范围 |
| attempt_id | 由哪个 attempt 写入 |
| output_id | 关联 ModelCall/流式输出 |
| role | system/user/assistant/tool |
| message_type | user、assistant、tool_call、tool_result 等 |
| visibility | ui/internal |
| channel | normal/progress/final |
| content | 文本 |
| tool_calls | AI tool call 数组 |
| tool_call_id/tool_name/tool_result | ToolMessage 协议 |

关键约束：

- tool_call 必须是 assistant 且 toolCalls 非空；
- tool_result 必须是 tool role 且有 call ID、name、result；
- role 与 messageType 必须匹配；
- system_prompt 必须 internal；
- job_id + output_id 唯一；
- Session 时间线以 row_id 排序，不以 createdAt 猜顺序。

#### agent_tool_invocations

保存 call/result Message、toolCallId、toolName、脱敏 arguments 与 checksum、sideEffectLevel、idempotencyKey、status、result/error、attemptId、executionAttemptNo 和 plan scope。

唯一约束：

- job + toolCallId；
- job + idempotencyKey。

#### agent_artifacts

保存逻辑文件的不可变版本：

- kind = file；
- area = code/docs/artifacts/downloads；
- logical_path；
- storage_path；
- media_type、size、checksum、revision；
- 关联 ToolInvocation 与 result Message。

唯一约束：

- session + logicalPath + revision；
- invocation + storagePath。

#### agent_user_input_requests

保存 source、answerMode、pending/answered/cancelled/expired、prompt、JSON schema、answer、answerMessageId 和 clientAnswerId。

一个 ToolInvocation 最多一个 UserInputRequest；job + clientAnswerId 唯一。

#### agent_context_summaries

保存 owner、purpose、rules version、summary type、source row 范围、parent/replaces、token、model、prompt version 和 checksum。

相同 owner、purpose、rules、summaryType 同时只允许一个 active。

#### agent_model_calls

保存模型输入审计、输出、usage、disposition。

关键唯一约束：

- job + logicalCallKey + callAttemptNo；
- job + outputId；
- 同一 job + logicalCallKey 同时只能一个 status = started。

#### agent_model_usage_stats

Session 聚合 model call 数、估算与实际 token、cache token、latest call/model、context usage ratio、warning level 和 version。

#### agent_loop_checkpoints

append-only 恢复边界。job + sequenceNo 唯一，按 sequenceNo desc 读最新。

#### agent_tool_execution_attempts

保存一个 ToolInvocation 的每次实际运行：jobAttemptId、attemptNo、workerId、status、error 与时间。invocation + attemptNo 唯一。

### 20.3 Schema 演进

| Version | 名称 | 内容 |
| --- | --- | --- |
| 1 | unified-job-react-canonical | 基础业务事实 |
| 2 | durable-react-checkpoints | LoopCheckpoint、ToolExecutionAttempt |
| 3 | explicit-job-recovery | recovery_required 与 active Job 唯一索引 |
| 4 | managed-workspace-processes | 历史迁移：曾引入常驻进程表 |
| 5 | local-workspace-process-supervision | 删除进程表；切换为 OS 发现、本地 spec 与内存 registry |

迁移必须显式执行 npm run schema:migrate。正常服务启动不会修改 schema。

---

## 21. 关键事务边界

| 操作 | 同一事务中的写入 |
| --- | --- |
| 创建 Job | Job + HumanMessage + Session version |
| 启动/恢复 attempt | Job attempt/lease + ready_for_model Checkpoint |
| 模型产生工具批次 | AI call Message + 所有 pending Invocations + tool_batch Checkpoint |
| 工具开始 | Invocation running + ToolExecutionAttempt running |
| 工具结果 | ToolMessage + Invocation terminal + ExecutionAttempt terminal + Artifacts + Plan evidence + 可选 ready Checkpoint |
| 进入 HITL | InputRequests + Invocation waiting + Job waiting + waiting Checkpoint |
| 回答 HITL | answer Message + Request answered + Invocation completed + Job resuming/new attempt + ready Checkpoint |
| Final | final AssistantMessage + Job completed + completed Checkpoint |
| Fail/Cancel | Job terminal + 子对象收敛 + terminal Checkpoint |
| 替换 Summary | 新 active Summary + 旧 Summary superseded |

事务通常先锁 Session 行以串行化消息时间线，再锁 Job 并校验 lease/attempt。row_id 由数据库提交前生成，是消息展示顺序的唯一标准。

---

## 22. SessionView 与 Timeline

当前 SessionView schemaVersion = 4：

~~~text
session
jobs[]
plans[]
planSteps[]
messages[]            仅公开 UI 消息
toolInvocations[]
artifacts[]
managedProcesses[]    SessionView 查询时合并的本机实时进程快照
userInputRequests[]
modelUsage
timeline.flat[]
cursor.latestMessageRowId
~~~

### 22.1 Tool exchange 聚合

TimelineBuilder 遍历 Message rowId：

1. 普通 Message → message item；
2. tool_call Message → tool_exchange item；
3. 找关联 Invocations；
4. 找 result Messages；
5. 找 Artifacts；
6. 单独的 result Message 不再重复展示。

工具交换状态优先级：

~~~text
unknown > waiting > running > pending > failed > cancelled > completed
~~~

unknown 会附带需要人工确认的 warning。

### 22.2 Plan 卡片位置

后端 View 返回 Plans 与 PlanSteps 实体，不直接将 Plan 做成 timeline row。

前端 buildTimelinePresentation 遇到 update_plan tool_exchange 时：

- 解析对应 Plan；
- 用该 tool call 的 rowId 作为 Plan 卡片锚点；
- 同一个 Plan 只展示一次；
- 后续 update_plan 工具卡不单独展示；
- 找不到锚点的 Plan 退化到时间线末尾。

因此 Plan 的首个 update_plan Message rowId 决定卡片位置，而不是 Plan.updatedAtMs。

---

## 23. SSE 与前端收敛

### 23.1 事件类型

后端领域定义：

1. message.delta
2. message.discarded
3. message.upserted
4. job.upserted
5. plan.upserted
6. plan_step.upserted
7. tool_invocation.upserted
8. user_input.upserted
9. model_usage.updated
10. artifact.upserted
11. managed_process.upserted

### 23.2 前端流程

~~~mermaid
sequenceDiagram
    participant UI as useAgentSession
    participant API as GET SessionView
    participant SSE as EventSource
    participant RED as sessionReducer

    UI->>API: 初次 GET /view
    API-->>RED: loaded(authoritative snapshot)
    UI->>SSE: connect
    SSE-->>UI: onOpen
    UI->>API: 再次 reload /view

    loop realtime
        SSE-->>RED: entity upsert / delta
        RED->>RED: versioned upsert + normalize timeline
    end

    Note over UI,RED: reload 会清空所有临时 delta
~~~

Reducer 规则：

- Message、Artifact 按 ID upsert；
- Job、Plan、PlanStep、ToolInvocation、InputRequest 按 version 拒绝旧事件；
- message.delta 以 jobId + planStepId + messageId + outputId 为 key 累加；
- 正式 Message 已存在时忽略重复 delta；
- message.upserted 到达时删除同 messageId/outputId 的 delta；
- failed/cancelled/recovery_required 到达时清掉该 Job delta；
- 每次 normalize 重新按 rowId 生成 tool_exchange。

### 23.3 Pending 状态

前端不是只看“有没有 delta”：

1. 已有 committed final → committed；
2. Job 非 active → hidden；
3. pending UserInputRequest → user_input activity；
4. active ToolInvocation → tool_call activity；
5. active Plan → plan activity；
6. 有 delta → streaming；
7. 否则 → pending。

### 23.4 权威性与当前缺口

~~~text
PostgreSQL business facts + OS process snapshot > SessionView refresh > SSE incremental projection > local delta
~~~

当前 SSE 是进程内 RxJS Subject：

- 没有 durable event log；
- 不支持 Last-Event-ID 重放；
- 服务重启后旧事件消失；
- 断线恢复依赖重新 GET SessionView；
- 广播失败依赖刷新纠正。

其中 Job、Message、Plan、ToolInvocation、Artifact 等来自 PostgreSQL；`managedProcesses[]` 是 SessionView 在读取时通过本地进程读取器动态合并的 overlay，不是数据库事实。

前端 AgentApi.subscribeSessionEvents 的事件订阅列表当前漏掉 artifact.upserted，虽然 reducer 已实现 Artifact upsert。Artifact 因而往往要等下一次 reload 才出现。

连接 onOpen 后立即 reload 可以降低事件丢失风险，但当前没有 snapshot cursor + replay 协议，理论上仍存在“GET 快照期间新事件到达、随后 loaded 覆盖增量”的竞态窗口。最终刷新能收敛，实时过程不是严格无缝。

---

## 24. Artifact 与 Session 工作区

默认目录：

~~~text
.agent-sandbox/
  sessions/
    session_xxx/
      workspace/
        code/
        docs/
        artifacts/
        downloads/
        .revisions/
          invocation_xxx/
            original/logical/path
~~~

原则：

- Session 即工作区隔离单元，不需要额外 projectId；
- logicalPath 是用户可理解的稳定路径；
- storagePath 指向某次不可变 revision；
- 同一 logicalPath 每次写入 revision + 1；
- Timeline 资源卡片按 ToolInvocation 关联 Artifact；
- 删除 Session 时数据库级联删除事实，随后移除工作区。

数据库删除与文件系统删除不是跨资源原子事务。当前顺序是先删数据库，再 removeSessionSandbox；文件删除失败时需要清理孤儿目录。

---

## 25. 并发、顺序与幂等不变量

1. 消息顺序只看 row_id，不看 createdAtMs，不看前端到达顺序。
2. 一个 Session 一个 active Job，由数据库唯一索引保证。
3. 一个 Job 一个 active executor per process，由内存 Map 保证。
4. 跨进程执行权看 lease，每次关键写入都 fence。
5. 调用事实先提交，再执行工具。
6. 每个稳定工具结果先提交，再执行下一个 sibling。
7. Job + toolCallId 唯一。
8. Job + idempotencyKey 唯一。
9. Job + outputId 的 Message 唯一。
10. ModelCall logical key 有 started 唯一约束。
11. 前端实体按 version upsert，晚到旧 SSE 不能回滚状态。
12. Retry 默认不复制 HumanMessage，通过 retry lineage 与 goalMessageId 保留目标。

---

## 26. 错误语义

### 26.1 Job error

Job 终态记录 errorCode、errorMessage、errorDetails。常见来源：

- model_error；
- context_error/context_overflow；
- invalid_plan_state；
- max_iterations；
- max_tool_calls；
- deadline_exceeded；
- invalid_tool_batch；
- unsafe_tool_recovery；
- persistence/lease conflict；
- aborted。

### 26.2 Tool error

ToolInvocation failed 会有 errorCode、errorMessage、errorDetails 和正式 ToolResult Message。

工具失败通常不是 Job 立即失败。模型下一轮会看到 ToolMessage，可以改参数、换工具或解释失败。只有执行基础设施无法维持协议时才终止整个 Job。

### 26.3 UI 展示

- failed/cancelled Job 形成终态卡片；
- recovery_required 形成“继续任务”入口；
- unknown ToolInvocation 显示风险 warning；
- 已被 Retry 替代的旧失败卡片默认隐藏；
- 数据库审计事实不删除。

---

## 27. 可观测性与调试

| 需求 | 数据源 |
| --- | --- |
| 模型当时看见什么 | model_calls.input_messages + context API |
| 模型为什么超上下文 | inputManifest + token breakdown |
| 哪一轮调用了什么工具 | call Message + ToolInvocations |
| 工具是否真的执行过 | ToolExecutionAttempts |
| 工具结果是否提交 | resultMessageId + ToolMessage |
| 恢复从哪里开始 | latest LoopCheckpoint |
| 哪个 worker 拥有任务 | Job leaseOwner/currentAttemptId |
| Plan 当前进度 | Plan + PlanSteps |
| 文件哪个版本 | Artifact logicalPath/revision/checksum |
| 页面为什么这样显示 | SessionView + timeline.flat |
| 实时 token | model_usage.updated + usage stats |

尚未提供 HTTP 读接口的内部事实包括完整 Checkpoint 历史和 ToolExecutionAttempt 历史，需要直接查数据库或新增只读审计接口。

---

## 28. 测试覆盖地图

| 测试 | 主要覆盖 |
| --- | --- |
| agent-loop.test.ts | 流式、工具批次、限制、取消、组装 |
| agent-runtime.test.ts | HTTP 应用入口到 JobManager 的命令委托 |
| job-execution-supervisor.test.ts | 中断 Job 扫描与 recovery_required 迁移 |
| job-manager.test.ts | 创建、取消、Retry、幂等与执行调度 |
| runtime-event-writer.test.ts | LoopEvent 到事务/SSE |
| unified-react-plan.test.ts | update_plan 与统一 ReAct |
| context-builder.test.ts | Group、Bundle、预算、Context |
| turn-bundle-builder.test.ts | Retry lineage |
| context-compression.service.test.ts | 统一 Context Memory 替换、精确覆盖与当前 Job 内压缩 |
| context-inspection.service.test.ts | Context 查询 |
| context-preview.service.test.ts | HTTP 调试投影 |
| runtime-tools.test.ts | 文件、Shell、HITL 等工具 |
| postgres-agent-store.test.ts | 真实事务、租约、恢复、Artifact |
| postgres-schema-v1.test.ts | v1→v2→v3 与 guard |
| public-projection.test.ts | 敏感信息脱敏 |
| row-mappers.test.ts | DB row 到领域模型 |
| domain.test.ts | 状态与事件枚举 |

命令：

~~~bash
npm run typecheck
npm test
npm run test:postgres
npm run test:all
npm run build
npm run schema:migrate
npm run schema:reset
~~~

PostgreSQL 集成测试不在默认 npm test 内，必须单独运行 test:postgres 或 test:all。

---

## 29. 当前已确认的边界与风险

### P0/P1：恢复与外部副作用

1. side_effecting 工具中断后只有 unknown + Job fail，没有人工 reconcile 后继续的流程。
2. run_shell 权限完全开放，应把工具开放策略视为安全控制面。
3. execution deadline 绑定原 Job.startedAtMs，长时间暂停后 Resume 可能立即超时。

### P1：实时一致性

1. SSE 无 durable replay 与 cursor handshake。
2. 前端漏订阅 artifact.upserted。
3. onOpen reload 与增量事件之间仍有理论竞态。

### P1/P2：审计模型

1. JobAttempt 没有独立表，只能从关联事实重建。
2. Checkpoint 与 ToolExecutionAttempt 没有公开只读接口。
3. transient correction messages 崩溃后不恢复，但旧 ModelCall 精确输入仍可审计。

### P2：架构耦合

1. update_plan 工具内直接发布 Plan 事件，工具层与实时投影耦合。
2. Session 删除的 DB 与文件系统不是原子操作。
3. RuntimeExceptionFilter 对部分可预期 RuntimeError 仍返回 500。

这些不是本文建议“必须立刻改”的目标列表，而是理解当前可靠性边界时不能忽略的事实。

---

## 30. 一次完整复杂任务的端到端案例

用户请求：“调查三篇新闻，整理结论，写成 Markdown；中途让我确认侧重点。”

~~~mermaid
sequenceDiagram
    autonumber
    participant U as User/UI
    participant A as AgentRuntime
    participant DB as PostgreSQL
    participant L as ReAct/Model
    participant T as Tools

    U->>A: 创建 Job + HumanMessage
    A->>DB: Job created + goal Message
    A->>DB: Job running + Attempt 1 + ready checkpoint

    A->>L: Context 1
    L->>DB: ModelCall 1
    L->>T: update_plan
    T->>DB: Plan active + Step 1 in_progress
    T->>DB: update_plan ToolResult + ready checkpoint

    A->>L: Context 2，包含 Plan tool exchange
    L->>T: web_search
    T->>DB: Search ToolResult，证据挂 Step 1

    A->>L: Context 3
    L->>T: update_plan，推进 Step 2
    T->>DB: Plan 更新

    A->>L: Context 4
    L->>T: request_user_input
    T->>DB: Job waiting + InputRequest + waiting checkpoint
    DB-->>U: SSE 展示输入卡片

    U->>A: answerInputRequest
    A->>DB: ToolMessage answer + Attempt 2 + Job resuming

    A->>L: Context 5，包含用户答案 ToolMessage
    L->>T: write_article
    T->>DB: ToolResult + Artifact revision 1

    A->>L: Context 6
    L->>T: update_plan，全部 completed
    T->>DB: Plan completed

    A->>L: Context 7
    L-->>A: final text
    A->>DB: final Message + Job completed + completed checkpoint
    DB-->>U: SSE 正式回复与资源卡片
~~~

最终数据库至少留下：

- 1 Session；
- 1 Job；
- 2 Job attempts；
- 1 HumanMessage；
- 多条 AI tool_call 与 ToolMessages；
- 1 Plan + 多个 PlanSteps；
- 多个 ToolInvocations 与 execution attempts；
- 1 UserInputRequest；
- 1 Artifact；
- 多次 ModelCalls；
- 多条 LoopCheckpoints；
- 1 Final AssistantMessage；
- 聚合 ModelUsageStats。

刷新页面时不依赖之前收到过哪些 SSE，SessionView 直接从这些事实重建 UI。

---

## 31. 代码阅读顺序

1. src/domain/job.ts：Job 状态。
2. src/orchestration/agent-runtime.ts：HTTP 应用入口与 Session 用例。
3. src/orchestration/job-manager.ts：Job 用户命令与状态编排。
4. src/orchestration/job-execution-supervisor.ts：执行所有权、心跳与后台调度。
5. src/orchestration/helpers/job-persistence.helper.ts：AgentStore 原子命令适配。
6. src/runtime/execution/react-execution.ts：Checkpoint 恢复。
7. src/agent-loop/agent-loop.ts：ReAct 算法。
8. src/runtime/execution/helpers/durable-loop-execution.helper.ts 与
   runtime-event-writer.ts：事件落库。
9. src/runtime/execution/tool-executor.ts：工具重放与副作用。
10. src/tools/plan-tools.ts 与 hitl-tools.ts：Plan/HITL。
10. src/runtime/context/react-context.service.ts：唯一 Context 入口。
11. src/runtime/context/context-compiler.ts 与
    context-compression.service.ts：Context 纯编译和压缩算法。
12. src/storage/postgres/transaction-commands.ts：原子边界与 fence。
13. src/view/session-view.ts 与 timeline-builder.ts：刷新读模型。
14. 前端 sessionReducer.ts、timeline-presentation.ts、job-output-state.ts：SSE 收敛。

---

## 32. 最终判断

当前 Runtime 的核心价值不在“又写了一个 while loop”，而在于把 Agent 行为拆成可审计和恢复的稳定事实：

- Human/AI/Tool 消息协议完整；
- 每次模型输入可重建；
- 工具有副作用等级、执行 attempt 与结果重放；
- ReAct 有持久化 Checkpoint；
- Plan 是同一循环内的 durable progress；
- HITL 是可恢复的工具协议；
- Artifact 有不可变版本；
- Job 有租约、版本和人工恢复；
- View 能从数据库重新生成。

它还不是任意节点都能 exactly-once 恢复的工作流引擎。当前保证更准确地说是：

**数据库事实可恢复，稳定结果可重放；read-only/idempotent 工具可自动重试；不可判定的外部副作用宁可停下来，也不盲目重复。**

这就是后续演进必须共同遵守的当前基线。
