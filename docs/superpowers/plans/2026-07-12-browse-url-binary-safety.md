# browse_url Binary Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `browse_url` binary responses and NUL-containing JSON tool artifacts from causing PostgreSQL `22P05` storage failures.

**Architecture:** Enforce response media-type policy at the browser-tool boundary before reading the body, and normalize JSON-compatible tool output once in `jsonToolOutput` so its content and artifact share the same PostgreSQL-safe value. Preserve all runtime persistence and execution code unchanged.

**Tech Stack:** TypeScript 5, Node.js Fetch API, LangChain `DynamicStructuredTool`, Vitest, PostgreSQL integration tests.

---

## File structure

- Modify `src/tools/browser-tools.ts`: classify response `Content-Type` and reject non-text bodies before `Response.text()`.
- Modify `src/tools/tool-utils.ts`: recursively remove NUL from JSON-compatible strings and keys before returning content/artifact.
- Modify `tests/runtime-tools.test.ts`: reproduce PDF rejection and nested NUL normalization.

### Task 1: Add failing browser and output safety tests

**Files:**
- Modify: `tests/runtime-tools.test.ts`

- [ ] **Step 1: Import test helpers and output utility**

Add `vi` to the Vitest import and import `jsonToolOutput`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonToolOutput } from '../src/tools/tool-utils.js';
```

- [ ] **Step 2: Add PDF media-type regression test**

Stub fetch for a public IP so DNS does not affect the test. Verify the body reader is never called:

```ts
it('rejects PDF responses before decoding the binary body', async () => {
  const text = vi.fn(async () => '%PDF-1.5\u0000binary');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    url: 'https://93.184.216.34/report.pdf',
    headers: new Headers({ 'content-type': 'application/pdf' }),
    text,
  })));

  await expect(invoke('browse_url', {
    url: 'https://93.184.216.34/report.pdf',
  })).rejects.toThrow('application/pdf');
  expect(text).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Add nested NUL normalization test**

```ts
it('removes NUL characters from JSON tool content and artifacts', () => {
  const [content, artifact] = jsonToolOutput({
    'nul\u0000key': ['a\u0000b', { nested: '\u0000value\u0000' }],
  });
  expect(artifact).toEqual({ nulkey: ['ab', { nested: 'value' }] });
  expect(content).toBe('{"nulkey":["ab",{"nested":"value"}]}');
  expect(jsonToolOutput('a\u0000b')).toEqual(['"ab"', 'ab']);
});
```

- [ ] **Step 4: Restore globals after every test**

Add to the existing `afterEach`:

```ts
vi.unstubAllGlobals();
```

- [ ] **Step 5: Run the focused tests and verify failure**

Run:

```bash
npx vitest run tests/runtime-tools.test.ts
```

Expected: PDF test fails because the body is decoded; NUL test fails because artifact strings remain unchanged.

### Task 2: Implement media-type and JSON safety boundaries

**Files:**
- Modify: `src/tools/browser-tools.ts`
- Modify: `src/tools/tool-utils.ts`
- Test: `tests/runtime-tools.test.ts`

- [ ] **Step 1: Add response media-type validation**

Before `response.text()`, validate the normalized media type:

```ts
const mediaType = response.headers.get('content-type')
  ?.split(';', 1)[0]
  ?.trim()
  .toLowerCase();
if (!mediaType || !isTextMediaType(mediaType)) {
  throw new Error(
    `Unsupported content type ${JSON.stringify(mediaType ?? 'unknown')} for browse_url. `
    + 'Use a dedicated file or PDF tool instead.'
  );
}
```

Implement the focused classifier:

```ts
export function isTextMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  return normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized === 'application/xml'
    || normalized === 'application/xhtml+xml'
    || /^application\/[a-z0-9!#$&^_.+-]+\+(?:json|xml)$/.test(normalized);
}
```

- [ ] **Step 2: Normalize JSON-compatible output**

Replace the existing `jsonToolOutput` implementation with a recursive copier:

```ts
export function jsonToolOutput(result: unknown): [string, unknown] {
  const safeResult = sanitizeJsonValue(result);
  return [JSON.stringify(safeResult), safeResult];
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key.replaceAll('\u0000', ''),
    sanitizeJsonValue(child),
  ]));
}
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npx vitest run tests/runtime-tools.test.ts
```

Expected: all runtime tool tests pass.

- [ ] **Step 4: Commit the focused fix**

```bash
git add src/tools/browser-tools.ts src/tools/tool-utils.ts tests/runtime-tools.test.ts
git commit -m "fix: reject binary browser responses safely"
```

### Task 3: Full regression verification

**Files:**
- No production file changes expected.

- [ ] **Step 1: Run typecheck and all unit tests**

```bash
npm run typecheck
npm test
```

Expected: both commands pass.

- [ ] **Step 2: Run PostgreSQL integration tests and build**

```bash
npm run test:postgres
npm run build
```

Expected: 24 PostgreSQL integration tests pass and TypeScript production build succeeds.

- [ ] **Step 3: Verify persistence boundaries remain unchanged**

```bash
git diff --exit-code HEAD~1 -- \
  src/storage/agent-store.ts \
  src/storage/postgres/schema-v1.ts \
  src/storage/postgres/transaction-commands.ts \
  src/runtime/runtime-event-writer.ts
```

Expected: no output.
