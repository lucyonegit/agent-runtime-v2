# Step Context Message Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current PlanStep instruction the final message in every initial or resumed Step Context without changing persisted history.

**Architecture:** Add an optional trailing fixed-message section to pure `ContextMaterial`; compile it after selected history groups. Move only the Step instruction into that section, leaving Direct and all persistence paths unchanged.

**Tech Stack:** TypeScript 5, LangChain `SystemMessage`, Vitest, PostgreSQL integration tests.

---

### Task 1: Lock the expected Step message order

**Files:**
- Modify: `tests/context-loaders.test.ts`

- [ ] **Step 1: Add final-instruction assertions**

In the existing complete Step context test, assert that historical/current Step messages precede the instruction and the instruction is last:

```ts
const contents = compiled.messages.map(item => item.content);
expect(contents.indexOf('current tail')).toBeLessThan(contents.indexOf(
  'Current PlanStep — execute only this step. Do not execute later PlanSteps:\ndo step two'
));
expect(contents.at(-1)).toBe(
  'Current PlanStep — execute only this step. Do not execute later PlanSteps:\ndo step two'
);
```

- [ ] **Step 2: Run the focused test and verify failure**

```bash
npx vitest run tests/context-loaders.test.ts
```

Expected: FAIL because the current instruction is emitted before all groups.

### Task 2: Add trailing context material

**Files:**
- Modify: `src/runtime/context/context-material.ts`
- Modify: `src/runtime/context/context-compiler.ts`
- Modify: `src/runtime/loaders/step-context-loader.ts`
- Test: `tests/context-loaders.test.ts`

- [ ] **Step 1: Extend ContextMaterial**

```ts
export interface ContextMaterial {
  fixedMessages: ContextFixedMessage[];
  trailingMessages?: ContextFixedMessage[];
  // existing fields remain unchanged
}
```

- [ ] **Step 2: Compile trailing messages after groups**

After adding all group items, add trailing messages as must-keep system items:

```ts
for (const trailing of material.trailingMessages ?? []) {
  items.push({
    id: trailing.id,
    value: { kind: 'message', message: trailing.message, category: 'system' },
    estimatedTokens: estimateTextTokens(trailing.text),
    mustKeep: true,
    priority: 1_000,
    recency: Number.MAX_SAFE_INTEGER,
    originalOrder: order++,
  });
}
```

- [ ] **Step 3: Move the Step instruction to the tail**

Remove the instruction push from `fixedMessages` and define:

```ts
const currentInstruction =
  `Current PlanStep — execute only this step. Do not execute later PlanSteps:\n${input.step.instruction}`;

return {
  fixedMessages,
  trailingMessages: [{
    id: 'must_keep:instruction',
    message: new SystemMessage(currentInstruction),
    text: currentInstruction,
  }],
  // existing material fields remain unchanged
};
```

Keep `fixedPrefix.currentInstruction` equal to the full strengthened instruction so ModelCall reconstruction remains deterministic.

- [ ] **Step 4: Run focused Context tests**

```bash
npx vitest run tests/context-loaders.test.ts tests/context-builder.test.ts tests/context-inspection.service.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/context src/runtime/loaders/step-context-loader.ts tests/context-loaders.test.ts
git commit -m "fix: place current step instruction after history"
```

### Task 3: Full regression verification

**Files:**
- No additional production changes expected.

- [ ] **Step 1: Run all unit and PostgreSQL tests**

```bash
npm test
npm run test:postgres
```

Expected: all unit tests and 24 PostgreSQL integration tests pass.

- [ ] **Step 2: Run typecheck and build**

```bash
npm run typecheck
npm run build
```

Expected: both pass.

- [ ] **Step 3: Verify persistence and UI boundaries**

```bash
git diff --exit-code HEAD~1 -- \
  src/storage \
  src/view \
  src/runtime/runtime-event-writer.ts \
  src/runtime/transaction-commands.ts
```

Expected: no output.
