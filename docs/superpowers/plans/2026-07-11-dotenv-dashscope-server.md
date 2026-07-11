# Dotenv + DashScope Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load local PostgreSQL and DashScope credentials from `.env` and start the canonical Agent Runtime server with the DashScope OpenAI-compatible API.

**Architecture:** `dotenv/config` loads local configuration before server initialization. A pure model-config resolver selects DashScope or the OpenAI-compatible fallback, while `main.ts` wires the selected configuration into the LangChain `BaseChatModel` provider factory and `RuntimeJobExecutionService`.

**Tech Stack:** TypeScript, Node.js ESM, dotenv, LangChain ChatOpenAI, NestJS/Fastify, PostgreSQL, Vitest

---

### Task 1: Add model configuration contract

**Files:**
- Create: `src/server/runtime/model-config.ts`
- Create: `tests/model-config.test.ts`

- [ ] **Step 1: Write failing resolver tests**

```ts
expect(resolveModelRuntimeConfig({ DASHSCOPE_API_KEY: 'dash-key' })).toEqual({
  apiKey: 'dash-key',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  modelName: 'qwen-plus',
  provider: 'dashscope',
});
```

Add cases for explicit `OPENAI_BASE_URL`/`OPENAI_MODEL`, OpenAI fallback, and missing credentials.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/model-config.test.ts`

Expected: FAIL because `model-config.ts` does not exist.

- [ ] **Step 3: Implement the pure resolver**

```ts
export function resolveModelRuntimeConfig(env: NodeJS.ProcessEnv): ModelRuntimeConfig {
  if (env.DASHSCOPE_API_KEY) {
    return {
      apiKey: env.DASHSCOPE_API_KEY,
      baseURL: env.OPENAI_BASE_URL ?? DASHSCOPE_BASE_URL,
      modelName: env.OPENAI_MODEL ?? 'qwen-plus',
      provider: 'dashscope',
    };
  }
  return {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    modelName: env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    provider: 'openai-compatible',
  };
}
```

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/model-config.test.ts`

Expected: all model-config tests pass.

### Task 2: Load dotenv and wire DashScope

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/server/main.ts`

- [ ] **Step 1: Install dotenv**

Run: `npm install dotenv`

Expected: `dotenv` appears under production dependencies.

- [ ] **Step 2: Load `.env` before server initialization**

Add at the top of `src/server/main.ts`:

```ts
import 'dotenv/config';
```

- [ ] **Step 3: Replace direct OpenAI environment reads**

```ts
const modelConfig = resolveModelRuntimeConfig(process.env);
const model = createModel(modelConfig);
```

Pass `modelConfig.provider` and `modelConfig.modelName` into `RuntimeJobExecutionService`. Construct a LangChain `ChatOpenAI` through `createLangChainChatModel` with `modelConfig.apiKey`, `modelConfig.baseURL`, and `modelConfig.modelName`.

- [ ] **Step 4: Run typecheck and unit tests**

Run: `npm run typecheck && npm test`

Expected: TypeScript succeeds and all ordinary tests pass.

### Task 3: Add local environment and verify startup

**Files:**
- Create, ignored: `.env`

- [ ] **Step 1: Write local environment values**

Write the supplied `DATABASE_URL` and `DASHSCOPE_API_KEY` plus the documented DashScope base URL, `qwen-plus`, host, and port. Do not display the resulting file.

- [ ] **Step 2: Confirm Git exclusion**

Run: `git check-ignore .env && git status --short`

Expected: `.env` is ignored and absent from Git status.

- [ ] **Step 3: Migrate the configured database**

Run: `npm run schema:migrate`

Expected: schema version 1 is ready without modifying non-`agent_*` objects.

- [ ] **Step 4: Build and start server**

Run: `npm run build && npm run serve`

Expected: NestJS listens on `127.0.0.1:3000`.

- [ ] **Step 5: Verify HTTP and model execution**

Create a Session, create a Job, poll `GET /sessions/:id/view`, and assert the Job reaches a terminal or HITL state. Verify server output and response payloads do not expose the API key.

- [ ] **Step 6: Run final regression and commit**

Run: `npm run typecheck && npm run test:all && npm run build`

Expected: all ordinary/PostgreSQL tests and build pass.

Commit:

```bash
git add package.json package-lock.json src/server tests/model-config.test.ts docs/superpowers
git commit -m "feat: load dashscope server config from dotenv"
```
