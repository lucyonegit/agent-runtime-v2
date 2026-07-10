# Sandboxed Runtime Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first real tool set to the runtime while constraining all filesystem effects to a per-session sandbox.

**Architecture:** React core receives a `toolContext` for each run and passes it to tools. Runtime tools live in `src/tools`, with path safety centralized in `sandbox.ts`; Qwen runtime only creates tools and binds OpenAI tool definitions.

**Tech Stack:** TypeScript, Vitest, LangChain OpenAI tool binding, Node `fs/path/child_process`.

---

### Task 1: Sandbox Path Resolver

**Files:**
- Create: `src/tools/sandbox.ts`
- Test: `tests/tools-sandbox.test.ts`

- [ ] Write tests proving relative paths resolve inside `sessions/<sessionId>/<area>`.
- [ ] Test absolute paths and `..` traversal are rejected.
- [ ] Implement `createSandbox`, `resolveSandboxPath`, `ensureSandboxArea`.
- [ ] Run `npm test tests/tools-sandbox.test.ts`.

### Task 2: Core Tool Context

**Files:**
- Modify: `src/core/react/react-core.ts`
- Modify: `src/orchestration/react-agent.ts`
- Modify: `src/orchestration/planner-react-agent.ts`
- Test: `tests/react-core.test.ts`

- [ ] Add `ReactCoreToolContext`.
- [ ] Change tool execution to `execute(args, context)`.
- [ ] Pass `{ sessionId, taskId, sandboxRoot }` from orchestration.
- [ ] Run core and orchestration tests.

### Task 3: Runtime Tool Modules

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/basic-tools.ts`
- Create: `src/tools/artifact-tools.ts`
- Create: `src/tools/filesystem-tools.ts`
- Create: `src/tools/browser-tools.ts`
- Create: `src/tools/index.ts`
- Modify: `src/server/qwen-runtime.ts`
- Test: `tests/runtime-tools.test.ts`

- [ ] Move `get_current_time` and `calculate` out of `qwen-runtime.ts`.
- [ ] Add `write_article`, `list_files`, `read_file`, `write_file`, `grep_files`, `browse_url`, `web_search`.
- [ ] Return structured `result` objects for UI and persisted tool messages.
- [ ] Generate OpenAI function definitions from tool schemas.
- [ ] Run `npm test tests/runtime-tools.test.ts`.

### Task 4: Verification

**Files:**
- All touched runtime files.

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Restart API if needed.
