# Workspace Tool Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure websites and source code are written with `write_file` under `workspace/code`, while `write_article` is limited to non-code prose artifacts.

**Architecture:** Keep the existing Session sandbox and LangChain tool bridge. Remove HTML from the article tool contract, strengthen the filesystem tool contract, and share one routing instruction across Direct execution, Step execution, and planning so all runtime paths apply the same semantic boundary.

**Tech Stack:** TypeScript, LangChain `DynamicStructuredTool`, Vitest, PostgreSQL integration tests, NestJS runtime

---

### Task 1: Lock the tool contract with failing tests

**Files:**
- Modify: `tests/runtime-tools.test.ts`
- Test: `tests/runtime-tools.test.ts`

- [ ] **Step 1: Add assertions for non-overlapping tool contracts and code sandbox output**

```ts
it('routes source code to write_file and keeps write_article prose-only', async () => {
  const writeArticle = tools.find(item => item.tool.name === 'write_article')!.tool;
  const writeFile = tools.find(item => item.tool.name === 'write_file')!.tool;
  expect(writeArticle.description).toContain('Do not use for webpages or source code');
  expect(writeFile.description).toContain('webpages, applications, scripts, and source code');
  expect(JSON.stringify(writeArticle.schema)).not.toContain('html');

  await invoke('write_file', {
    path: 'code/index.html',
    content: '<!doctype html><title>Runtime</title>',
  });
  await expect(readFile(
    join(sandboxRoot, 'sessions', 'session_1', 'workspace', 'code', 'index.html'),
    'utf8'
  )).resolves.toContain('<title>Runtime</title>');
});
```

- [ ] **Step 2: Run the focused test and verify the current contract fails**

Run: `npx vitest run tests/runtime-tools.test.ts`

Expected: FAIL because `write_article` still accepts HTML and the descriptions do not define the code/prose boundary.

- [ ] **Step 3: Commit only after Task 2 implementation makes the test pass**

```bash
git add tests/runtime-tools.test.ts src/tools/artifact-tools.ts src/tools/filesystem-tools.ts
git commit -m "fix: separate code and prose file tools"
```

### Task 2: Implement the tool boundary

**Files:**
- Modify: `src/tools/artifact-tools.ts`
- Modify: `src/tools/filesystem-tools.ts`
- Test: `tests/runtime-tools.test.ts`

- [ ] **Step 1: Remove HTML from `write_article` and explicitly exclude code**

```ts
const formatExtensions: Record<string, string> = {
  markdown: '.md',
  text: '.txt',
};

description: 'Write a prose article, report, or long-form document into workspace/artifacts. Do not use for webpages or source code; use write_file with a code/ path instead.',

format: { type: 'string', enum: ['markdown', 'text'] },
```

- [ ] **Step 2: Make `write_file` the explicit code and webpage tool**

```ts
description: 'Write a UTF-8 file inside the shared Session workspace. Use code/ for webpages, applications, scripts, and source code; use docs/, artifacts/, downloads/, or tmp/ only when their category matches the requested deliverable.',

path: {
  type: 'string',
  description: 'Workspace-relative file path. Webpages and source code must use code/, for example code/index.html.',
},
```

- [ ] **Step 3: Run the focused tool tests**

Run: `npx vitest run tests/runtime-tools.test.ts`

Expected: all runtime tool tests pass, including a real sandbox write to `workspace/code/index.html`.

### Task 3: Apply one routing instruction to planning and execution

**Files:**
- Modify: `src/server/runtime/runtime-context-config.ts`
- Modify: `src/server/runtime/job-execution.service.ts`
- Modify: `src/server/runtime/default-planner.ts`
- Modify: `tests/context-preview.service.test.ts`
- Modify: `tests/postgres-agent-store.test.ts`

- [ ] **Step 1: Add assertions for the shared instruction and prompt version**

Update `tests/context-preview.service.test.ts` to expect `runtime-system-v2` and a system message containing the workspace routing instruction. Update the production runtime integration model in `tests/postgres-agent-store.test.ts` to assert that Step execution messages contain `Webpages, applications, scripts, and source code must use write_file`.

- [ ] **Step 2: Run the affected tests and verify they fail before implementation**

Run: `npx vitest run tests/context-preview.service.test.ts`

Run with the configured test database: `npm run test:postgres`

Expected: FAIL because the current version is `runtime-system-v1` and Step execution lacks the routing instruction.

- [ ] **Step 3: Define and reuse the routing instruction**

```ts
export const WORKSPACE_TOOL_ROUTING_INSTRUCTION =
  'Webpages, applications, scripts, and source code must use write_file with paths under code/. Use write_article only for non-code prose articles and reports.';

export const JOB_EXECUTION_SYSTEM_PROMPT =
  `Act as a reliable tool-using agent. Complete the user goal. ${WORKSPACE_TOOL_ROUTING_INSTRUCTION}`;

export const RUNTIME_SYSTEM_PROMPT_VERSION = 'runtime-system-v2';
```

Import `WORKSPACE_TOOL_ROUTING_INSTRUCTION` into `job-execution.service.ts` and build the Step system prompt as:

```ts
`Execute only the current PlanStep. ${WORKSPACE_TOOL_ROUTING_INSTRUCTION} ${STEP_OUTPUT_INSTRUCTION}`
```

Import the same constant into `default-planner.ts` and include it in the plan creation system message immediately after the available tool list.

- [ ] **Step 4: Run focused and PostgreSQL tests**

Run: `npx vitest run tests/context-preview.service.test.ts tests/runtime-tools.test.ts`

Run: `npm run test:postgres`

Expected: all focused and PostgreSQL tests pass.

- [ ] **Step 5: Commit the shared routing rule**

```bash
git add src/server/runtime/runtime-context-config.ts src/server/runtime/job-execution.service.ts src/server/runtime/default-planner.ts tests/context-preview.service.test.ts tests/postgres-agent-store.test.ts
git commit -m "fix: route code tasks to session workspace"
```

### Task 4: Full verification and runtime restart

**Files:**
- Verify: all changed source and test files

- [ ] **Step 1: Run all tests and build**

Run: `npm run test:all && npm run build`

Expected: 12 non-PostgreSQL test files pass, both PostgreSQL test files pass, and TypeScript build exits successfully.

- [ ] **Step 2: Restart the compiled server and smoke-test HTTP**

Stop only the Node process listening on `127.0.0.1:3000`, then run `npm run serve`.

Run: `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/sessions`

Expected: `200`.

- [ ] **Step 3: Verify repository state**

Run: `git status --short && git log -3 --oneline`

Expected: clean worktree with the tool-boundary and shared-routing commits at the top.
