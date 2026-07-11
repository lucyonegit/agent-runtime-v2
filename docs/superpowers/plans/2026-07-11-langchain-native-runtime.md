# LangChain-native Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace parallel model/tool protocols with LangChain-native messages, runnables, tools, streaming chunks, provider creation, and dotenv-backed DashScope startup.

**Architecture:** AgentLoop receives a LangChain Runnable and StructuredToolInterface instances. A Runnable audit decorator preserves PostgreSQL ModelCall accounting without converting AIMessage/AIMessageChunk into custom DTOs; persistence mappers remain the only LangChain-to-database serialization boundary.

**Tech Stack:** TypeScript, LangChain JS, ChatOpenAI, DynamicStructuredTool, Node.js ESM, dotenv, PostgreSQL, Vitest

---

### Task 1: Make domain tool calls LangChain-native

**Files:**
- Modify: `src/domain/message.ts`
- Modify: `src/context/context-formatter.ts`
- Test: `tests/context-builder.test.ts`

- [ ] Import LangChain `ToolCall` and define the persisted type as `ToolCall & { id: string }`.
- [ ] Include `name` when reconstructing `ToolMessage` and preserve `AIMessage.tool_calls` unchanged.
- [ ] Run `npm test -- tests/context-builder.test.ts` and confirm tool call/result protocol tests pass.

### Task 2: Replace custom model port with LangChain Runnable

**Files:**
- Delete: `src/agent-loop/model-port.ts`
- Create: `src/agent-loop/langchain-model.ts`
- Modify: `src/agent-loop/agent-loop.ts`
- Delete: `src/agent-loop/tool-call-assembler.ts`
- Modify: `src/index.ts`
- Test: `tests/agent-loop.test.ts`

- [ ] Define helpers that extract text and normalize LangChain ToolCall IDs without defining custom invoke/response interfaces.
- [ ] Change AgentLoop model input to `Runnable<BaseLanguageModelInput, AIMessageChunk>` and tools to `StructuredToolInterface[]`.
- [ ] For invoke, consume the returned LangChain message directly.
- [ ] For stream, concatenate `AIMessageChunk` objects and read `tool_calls`, `invalid_tool_calls`, and `usage_metadata`.
- [ ] Rewrite AgentLoop fixtures with LangChain Runnable fakes and assert LangChain message instances.
- [ ] Run `npm test -- tests/agent-loop.test.ts`.

### Task 3: Turn model audit into a Runnable decorator

**Files:**
- Modify: `src/runtime/audited-model-port.ts`
- Modify: `src/server/runtime/job-execution.service.ts`
- Modify: `src/server/runtime/default-planner.ts`
- Test: `tests/postgres-agent-store.test.ts`

- [ ] Make `AuditedChatModel` extend LangChain `Runnable<BaseLanguageModelInput, AIMessageChunk>`.
- [ ] Preserve invoke/stream outputs and read token counts from `usage_metadata`.
- [ ] Bind StructuredTool instances before wrapping the runnable.
- [ ] Update planner, repair, compression, and final summarizer to call LangChain Runnable signatures.
- [ ] Run ordinary and PostgreSQL runtime tests.

### Task 4: Replace runtime tool definitions with StructuredToolInterface

**Files:**
- Modify: `src/runtime/tool-executor.ts`
- Modify: `src/runtime/runtime-event-writer.ts`
- Modify: `src/server/runtime/default-tools.ts`
- Modify: `src/server/runtime/job-execution.service.ts`
- Test: `tests/postgres-agent-store.test.ts`

- [ ] Define RuntimeTool as `{ tool, sideEffectLevel, sensitiveArgumentPaths? }`.
- [ ] Return StructuredTool instances from ToolExecutor for model binding.
- [ ] Execute claimed calls with `tool.invoke({ type: 'tool_call', id, name, args }, config)`.
- [ ] Normalize returned `ToolMessage` content/artifact into durable result or HITL sentinel.
- [ ] Implement `request_user_input` as DynamicStructuredTool with `content_and_artifact` response format.
- [ ] Verify ordinary tool, sibling failure isolation, HITL and resume integration tests.

### Task 5: Use LangChain provider factory and dotenv

**Files:**
- Delete: `src/server/runtime/openai-model-port.ts`
- Create: `src/server/runtime/langchain-model-provider.ts`
- Create: `src/server/runtime/model-config.ts`
- Modify: `src/server/main.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create, ignored: `.env`
- Test: `tests/model-config.test.ts`

- [ ] Install `dotenv` and load `dotenv/config` before server initialization.
- [ ] Resolve DashScope/OpenAI configuration with pure unit-tested code.
- [ ] Return `ChatOpenAI` as `BaseChatModel`; do not wrap provider responses.
- [ ] Write the supplied database URL and API key to ignored `.env` without logging either value.
- [ ] Run schema migration against the configured PostgreSQL instance.

### Task 6: Full validation and documentation alignment

**Files:**
- Modify: `docs/refactor/06-完整Job-StepRun架构设计.md`
- Modify: `docs/refactor/07-实现验收与运维手册.md`
- Modify: `docs/superpowers/specs/2026-07-11-dotenv-dashscope-server-design.md`
- Modify: `docs/superpowers/plans/2026-07-11-dotenv-dashscope-server.md`

- [ ] Mark LangChain-native types as canonical and remove references to custom model/tool DTOs.
- [ ] Run `npm run typecheck`, `npm test`, `npm run test:postgres`, and `npm run build`.
- [ ] Start server with `.env`, verify `GET /sessions`, create a Job, and poll SessionView to a non-running state.
- [ ] Confirm `.env` is ignored and no secret appears in Git diff or logs.
- [ ] Commit the implementation as `refactor: make runtime langchain native`.
