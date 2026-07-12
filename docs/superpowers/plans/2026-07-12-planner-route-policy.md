# Planner Route Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route research-to-deliverable, explicit multi-stage, and non-trivial build goals to planned execution even when the model incorrectly returns direct.

**Architecture:** Keep the LLM router, clarify its execution-stage policy, then apply a small deterministic safety policy to prevent known complex goals from degrading to direct. Parse only valid route decisions and fail malformed responses explicitly.

**Tech Stack:** TypeScript 5, LangChain messages/runnables, Vitest, PostgreSQL runtime integration tests.

---

### Task 1: Add route policy regression tests

**Files:**
- Modify: `tests/default-planner.test.ts`

- [ ] **Step 1: Add a reusable planner helper**

```ts
function plannerWithRouteResponse(content: string) {
  return new DefaultPlanner({
    invoke: vi.fn(async () => new AIMessage(content)),
  } as never, { invoke: vi.fn() } as never);
}
```

- [ ] **Step 2: Lock complex goals to planned**

```ts
it('does not let complex research and build goals degrade to direct', async () => {
  const planner = plannerWithRouteResponse('{"strategy":"direct"}');
  await expect(planner.route({
    goal: '调查一下萧山机场UFO事件前因后果，写一个分析报告1000字',
  })).resolves.toBe('planned');
  await expect(planner.route({ goal: '写一个todo应用' })).resolves.toBe('planned');
});
```

- [ ] **Step 3: Preserve simple direct routing**

```ts
it('keeps genuinely simple goals direct', async () => {
  const planner = plannerWithRouteResponse('{"strategy":"direct"}');
  await expect(planner.route({ goal: '你好' })).resolves.toBe('direct');
  await expect(planner.route({ goal: '现在几点了？' })).resolves.toBe('direct');
});
```

- [ ] **Step 4: Lock parsing behavior**

```ts
it('accepts fenced route JSON and rejects invalid decisions', async () => {
  await expect(plannerWithRouteResponse('```json\n{"strategy":"planned"}\n```')
    .route({ goal: '普通任务' })).resolves.toBe('planned');
  await expect(plannerWithRouteResponse('I think direct')
    .route({ goal: '普通任务' })).rejects.toThrow('Invalid planner route response');
});
```

- [ ] **Step 5: Run the focused test and verify failure**

```bash
npx vitest run tests/default-planner.test.ts
```

Expected: complex goals remain direct, fenced JSON falls back direct, and invalid output does not reject.

### Task 2: Implement the route policy

**Files:**
- Modify: `src/server/runtime/default-planner.ts`
- Modify: `src/planner/planner-prompts.ts`
- Test: `tests/default-planner.test.ts`

- [ ] **Step 1: Replace the Router prompt**

Use a multiline prompt that defines direct as one reasoning pass with at most one tool call, and planned as two or more dependent stages. Explicitly state that research → verification → synthesis → one report is planned and that final deliverable count is irrelevant.

- [ ] **Step 2: Add deterministic complex-goal detection**

```ts
function requiresPlannedExecution(goal: string): boolean {
  const research = /调查|调研|研究|检索|搜索|搜集|核查|investigat|research|survey|search|collect/iu;
  const deliverable = /报告|文章|综述|总结|方案|report|article|analysis|brief|summary/iu;
  const staged = /先.{1,80}(?:再|然后|之后|接着|最后)|\b(?:and then|after that|followed by)\b/iu;
  const build = /(?:开发|构建|搭建|实现|创建|写|制作).{0,30}(?:应用|网站|系统|项目|程序|app|application|website|system|project)|(?:build|create|implement|develop).{0,40}(?:app|application|website|system|project)/iu;
  return research.test(goal) && deliverable.test(goal)
    || staged.test(goal)
    || build.test(goal);
}
```

- [ ] **Step 3: Parse valid decisions without silent fallback**

```ts
function parseRouteStrategy(content: string): 'direct' | 'planned' {
  const normalized = content.trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '');
  try {
    const parsed = JSON.parse(normalized) as { strategy?: unknown };
    if (parsed.strategy === 'direct' || parsed.strategy === 'planned') return parsed.strategy;
  } catch {
    // The stable error below owns malformed and invalid decisions.
  }
  throw new Error(`Invalid planner route response: ${JSON.stringify(content)}`);
}
```

Use the policy in `route`:

```ts
const modelStrategy = parseRouteStrategy(response.text);
return modelStrategy === 'planned' || requiresPlannedExecution(input.goal)
  ? 'planned'
  : 'direct';
```

- [ ] **Step 4: Bump the route prompt version**

```ts
export const PLANNER_ROUTE_PROMPT_VERSION = 'planner-route-v2';
```

- [ ] **Step 5: Run focused tests and typecheck**

```bash
npx vitest run tests/default-planner.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/runtime/default-planner.ts src/planner/planner-prompts.ts tests/default-planner.test.ts
git commit -m "fix: route multi-stage goals to planned execution"
```

### Task 3: Full verification

**Files:**
- No additional production changes expected.

- [ ] **Step 1: Run complete verification**

```bash
npm run typecheck
npm test
npm run test:postgres
npm run build
```

Expected: all commands pass.

- [ ] **Step 2: Verify frozen persistence boundaries**

```bash
git diff --exit-code HEAD~1 -- src/storage src/view src/runtime/runtime-event-writer.ts
```

Expected: no output.

- [ ] **Step 3: Restart the server and create the original goal**

After restart, submit `调查一下萧山机场UFO事件前因后果，写一个分析报告1000字` and verify the persisted Job strategy is `planned`.
