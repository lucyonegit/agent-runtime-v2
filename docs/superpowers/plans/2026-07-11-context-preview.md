# Context Preview Debugger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Session Context Preview endpoint and frontend JSON inspector backed by the same pure Context construction function used by normal model execution.

**Architecture:** Replace the state-free `ContextBuilder` class with `buildContext(input)`, and make the execution boundary explicit through a discriminated `ContextScope`. Runtime execution uses `job` or `step_run`; the preview service uses `session_history`. A thin server service loads persisted history and serializes the resulting LangChain messages; the React UI requests and displays that DTO only after active Jobs finish.

**Tech Stack:** TypeScript, LangChain messages/tools, NestJS/Fastify, PostgreSQL AgentStore, React 19, Vite, Vitest.

---

### Task 1: Convert ContextBuilder into one shared pure function

**Files:**
- Modify: `src/context/context-purpose.ts`
- Modify: `src/context/context-filter.ts`
- Modify: `src/context/context-builder.ts`
- Modify: `src/server/runtime/job-execution.service.ts`
- Modify: `tests/context-builder.test.ts`

- [ ] **Step 1: Add failing tests for session history and deterministic construction**

Add tests that call the future function twice and verify a history scope includes Plan, StepOutput and complete tools without mutating input:

```ts
const input: BuildContextInput = {
  purpose: 'job_execution',
  scope: { kind: 'session_history' },
  systemPrompt: 'system',
  systemPromptVersion: 'v1',
  messages,
  invocations,
  model: { provider: 'test', name: 'model', maxContextTokens: 4_000, reservedOutputTokens: 200 },
};
expect(buildContext(input).inputManifest.messageGroupIds).toEqual([
  'message:previous_user',
  'message:plan_created',
  'tool_exchange:previous_call',
  'step_output:previous_output',
  'message:plan_final',
]);
expect(buildContext(input).messages.map(item => item.content)).toEqual([
  'system',
  '调查并生成报告',
  '调查计划',
  '',
  'result:web_search',
  'structured step output',
  '最终报告',
]);
expect(input.messages).toEqual(messagesBeforeBuild);
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npm test -- --run tests/context-builder.test.ts`

Expected: FAIL because `buildContext` and `ContextScope` do not exist.

- [ ] **Step 3: Define the discriminated scope and pure function**

Add:

```ts
export type ContextScope =
  | { kind: 'session_history' }
  | { kind: 'job'; jobId: string; originalGoal: string }
  | { kind: 'step_run'; jobId: string; stepRunId: string; originalGoal: string };

export function buildContext(input: BuildContextInput): BuiltContext {
  // Existing deterministic grouping, filtering, budget selection and formatting body.
}
```

Replace `job`, `stepRun`, and unused `attemptId` inputs with `scope`. Update current-goal detection, incomplete-current-tool validation and priorities from the scope fields. `session_history` selects all complete non-internal, non-progress groups and has no must-keep current goal.

- [ ] **Step 4: Switch runtime execution to the pure function**

Use:

```ts
const scope = stepRun
  ? { kind: 'step_run' as const, jobId: job.id, stepRunId: stepRun.id, originalGoal }
  : { kind: 'job' as const, jobId: job.id, originalGoal };
const built = buildContext({ ...buildInput, scope });
```

Remove the `new ContextBuilder()` instance field. Compression rebuilds keep the same scope.

- [ ] **Step 5: Run focused and full backend unit tests**

Run: `npm test -- --run tests/context-builder.test.ts && npm test`

Expected: all Context tests and all non-PostgreSQL tests pass.

- [ ] **Step 6: Commit the shared core refactor**

```bash
git add src/context src/server/runtime/job-execution.service.ts tests/context-builder.test.ts
git commit -m "refactor: make context construction pure"
```

### Task 2: Add the read-only backend Context Preview endpoint

**Files:**
- Create: `src/server/debug/context-preview.service.ts`
- Create: `src/server/debug/context-preview-contract.ts`
- Create: `src/server/runtime/runtime-context-config.ts`
- Modify: `src/server/runtime/job-execution.service.ts`
- Modify: `src/server/http/agent-http.module.ts`
- Modify: `src/server/http/agent.controller.ts`
- Modify: `src/server/main.ts`
- Create: `tests/context-preview.service.test.ts`

- [ ] **Step 1: Write failing preview service tests**

Cover a completed Session, active Job rejection, missing Session, complete tool serialization, and no model/store mutations:

```ts
await expect(service.preview('session_running')).rejects.toMatchObject({
  code: 'concurrency_conflict',
});
const preview = await service.preview('session_complete');
expect(preview).toMatchObject({
  schemaVersion: 1,
  debugOnly: true,
  contextRulesVersion: CONTEXT_RULES_VERSION,
});
expect(preview.messages.map(item => item.type)).toEqual(['system', 'human', 'ai', 'tool']);
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run tests/context-preview.service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Extract shared runtime Context constants**

Create:

```ts
export const JOB_EXECUTION_SYSTEM_PROMPT = 'Act as a reliable tool-using agent. Complete the user goal.';
export const RUNTIME_SYSTEM_PROMPT_VERSION = 'runtime-system-v1';
```

Use these constants in both runtime execution and preview.

- [ ] **Step 4: Implement the preview service and DTO serializer**

The service loads Session, Jobs, Messages and ToolInvocations, rejects active statuses, calls:

```ts
const built = buildContext({
  purpose: 'job_execution',
  scope: { kind: 'session_history' },
  systemPrompt: JOB_EXECUTION_SYSTEM_PROMPT,
  systemPromptVersion: RUNTIME_SYSTEM_PROMPT_VERSION,
  messages,
  invocations,
  model: limits,
  toolSchemas: tools.map(item => item.tool),
});
```

Serialize only `index`, `type`, `content`, `name`, `toolCallId`, and `toolCalls`.

- [ ] **Step 5: Wire the Nest endpoint**

Add:

```ts
@Get('sessions/:sessionId/context-preview')
getContextPreview(@Param('sessionId') sessionId: string) {
  return this.contextPreview.preview(sessionId);
}
```

Pass one `ContextPreviewService` instance through `AgentHttpModule.forRoot(runtime, events, contextPreview)` from `main.ts`.

- [ ] **Step 6: Run backend tests and build**

Run: `npm test -- --run tests/context-preview.service.test.ts && npm run test:all && npm run build`

Expected: all preview tests, all backend unit tests, all PostgreSQL integration tests, and the TypeScript build pass.

- [ ] **Step 7: Commit the endpoint**

```bash
git add src/server tests/context-preview.service.test.ts
git commit -m "feat: expose context preview endpoint"
```

### Task 3: Add frontend API types and Context JSON dialog

**Files:**
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/api/types.ts`
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/api/agentApi.ts`
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/store/useAgentSession.ts`
- Create: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/components/ContextPreviewDialog.tsx`
- Create: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/components/context-preview-state.ts`
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/components/SessionShell.tsx`
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/src/styles.css`
- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/tests/agent-api.test.ts`
- Create: `/Users/hanljjie/Desktop/agent/agent-runtime-v2-web/tests/context-preview-state.test.ts`

- [ ] **Step 1: Write failing API and availability tests**

```ts
await api.getContextPreview('session_1');
expect(fetch).toHaveBeenCalledWith(
  'http://127.0.0.1:3000/sessions/session_1/context-preview',
  expect.anything(),
);
expect(canPreviewContext([completedJob])).toBe(true);
expect(canPreviewContext([runningJob])).toBe(false);
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm test`

Expected: FAIL because the API method and helper do not exist.

- [ ] **Step 3: Add the DTO and API method**

Add `ContextPreviewV1`, `ContextPreviewMessage`, and:

```ts
getContextPreview(sessionId: string) {
  return this.request<ContextPreviewV1>(
    `/sessions/${encodeURIComponent(sessionId)}/context-preview`,
  );
}
```

- [ ] **Step 4: Build the focused dialog component**

The component accepts `open`, `loading`, `preview`, `error`, `copied`, `onReload`, `onCopy`, and `onClose`. Render `JSON.stringify(preview, null, 2)` in a scrollable `<pre>` and provide Reload, Copy JSON, and Close buttons.

- [ ] **Step 5: Integrate Session state and the topbar button**

Use a Lucide `Braces` button. Disable it with no Session or while any Job is `created`, `running`, `waiting_user_input`, or `resuming`. On Session change, close and clear the dialog. Do not include composer draft text in the request.

- [ ] **Step 6: Add dialog styling**

Append scoped `.context-preview-*` rules for the modal layer, toolbar, JSON viewport, loading/error states, and responsive width. Preserve the current visual language.

- [ ] **Step 7: Run frontend tests and build**

Run: `npm test && npm run build`

Expected: all Vitest tests pass and Vite production build succeeds.

- [ ] **Step 8: Commit the frontend**

```bash
git add src tests
git commit -m "feat: add context preview inspector"
```

### Task 4: End-to-end verification and service restart

**Files:**
- No source changes expected.

- [ ] **Step 1: Restart backend and verify the endpoint**

Run backend `npm run serve`, then:

```bash
curl -sS http://127.0.0.1:3000/sessions/session_d1231bb3-ed0c-44f3-bcb7-d22e76c9e0df/context-preview
```

Expected: HTTP 200 with `debugOnly: true`, the current `contextRulesVersion`, manifest, and LangChain messages.

- [ ] **Step 2: Verify active Job protection**

Request a Session that has an active Job.

Expected: HTTP 409.

- [ ] **Step 3: Verify frontend production and live UI**

Open the active Vite app, select a completed Session, open Context, inspect JSON, reload it, copy it, and close it. Confirm the button is disabled for active Jobs.

- [ ] **Step 4: Confirm both worktrees are clean**

Run:

```bash
git -C /Users/hanljjie/Desktop/agent/agent-runtime-v2 status --short
git -C /Users/hanljjie/Desktop/agent/agent-runtime-v2-web status --short
```

Expected: no uncommitted source changes.
