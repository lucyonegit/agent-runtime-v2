# Planner Context Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Planner + ReAct LangChain contexts deterministic and clean: plan creation, step execution, and final synthesis must consume explicit projected context instead of raw session history.

**Architecture:** Persisted `agent_messages` remains the complete audit log. Orchestration builds purpose-specific context projections before calling LangChain: `plan.create`, `plan.step.react`, and `plan.finalize`. Cross-step propagation uses only stable `step_result` messages; current-step runtime history is included only to preserve tool call/result continuity during the same step.

**Tech Stack:** TypeScript, LangChain `BaseMessage`, Vitest, existing `AgentSessionStore`, existing `ContextBuilder`.

---

## Desired LangChain Context Contract

### Plan Creation

Only these messages may be passed to `planner.createPlanWithUsage()`:

```ts
[
  new SystemMessage(PLANNER_SYSTEM_PROMPT),
  new HumanMessage([
    '当前日期：2026-07-09',
    '当前时区：Asia/Shanghai',
    '用户目标：...',
    '可见会话摘要：...',
  ].join('\n'))
]
```

Must not include:

- ReAct system prompts.
- planner step input system messages.
- previous step tool calls/results.
- old planner JSON.
- internal messages.

### Step ReAct Execution

On the first call of a step:

```ts
[
  new SystemMessage(REACT_SYSTEM_PROMPT),
  new HumanMessage([
    '当前日期：2026-07-09',
    '当前时区：Asia/Shanghai',
    '用户原始目标：...',
    '当前计划：...',
    '已完成步骤结果：...',
    '现在只执行当前步骤：...',
  ].join('\n'))
]
```

After the current step has tool results and needs to continue:

```ts
[
  new SystemMessage(REACT_SYSTEM_PROMPT),
  new HumanMessage('...same projected task brief...'),
  new AIMessage({ content: '...', tool_calls: [{ id: 'call_1', name: 'web_search', args: {} }] }),
  new ToolMessage({ tool_call_id: 'call_1', content: '...' })
]
```

Must not include:

- previous steps' ReAct prompts.
- previous steps' tool calls/results.
- planner creation prompt.
- raw failed searches from previous steps.

### Plan Finalization

Only these messages may be passed to `planner.completePlanWithUsage()`:

```ts
[
  new SystemMessage(PLANNER_FINAL_SYSTEM_PROMPT),
  new HumanMessage([
    '当前日期：2026-07-09',
    '当前时区：Asia/Shanghai',
    '用户目标：...',
    '计划标题：...',
    '计划步骤：...',
    '步骤执行结果：...',
  ].join('\n'))
]
```

Must not include raw step runtime messages.

---

## File Structure

### Create

- `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/orchestration/planner-context-projection.ts`
  - Owns all planner context projection functions.
  - Converts persisted `AgentMessage`/`AgentTask`/`AgentPlan` data into clean `BaseMessage[]`.

- `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/planner-context-projection.test.ts`
  - Unit tests for context projection without model calls.

### Modify

- `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/orchestration/planner-react-agent.ts`
  - Replace scattered manual context building with projection functions.
  - Persist explicit `step_result` messages.
  - Ensure every step produces `step_result` before advancing.

- `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/context/context-builder.ts`
  - Keep tool-call pairing conversion.
  - Do not use `buildForModel(sessionId)` for planner create or final context.

- `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/planner.test.ts`
  - Add orchestration-level assertions around step result propagation if existing fixtures allow it.

- `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/session-view.test.ts`
  - Keep UI projection tests passing after introducing `step_result`.

---

## Task 1: Add Context Projection Unit

**Files:**

- Create: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/orchestration/planner-context-projection.ts`
- Create: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/planner-context-projection.test.ts`

- [ ] **Step 1: Write failing projection tests**

Create `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/planner-context-projection.test.ts`:

```ts
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  buildPlanCreateMessages,
  buildPlanFinalMessages,
  buildPlanStepMessages,
} from '../src/orchestration/planner-context-projection.js';
import type { AgentMessage, AgentPlan, AgentTask } from '../src/domain/index.js';

const nowContext = {
  currentDate: '2026-07-09',
  timeZone: 'Asia/Shanghai',
};

const plan: AgentPlan = {
  id: 'plan_1',
  title: 'Research Plan',
  steps: [
    { id: 'step_1', title: 'Search facts', instruction: 'Search reliable sources' },
    { id: 'step_2', title: 'Verify facts', instruction: 'Cross-check facts' },
  ],
};

const plannerTask: AgentTask = {
  id: 'task_plan',
  sessionId: 'session_1',
  kind: 'planner',
  executor: 'planner',
  status: 'running',
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};

const step1Task: AgentTask = {
  id: 'task_step_1',
  sessionId: 'session_1',
  parentTaskId: 'task_plan',
  kind: 'planner_step',
  executor: 'react',
  status: 'completed',
  version: 1,
  createdAt: 2,
  updatedAt: 2,
  metadata: { stepId: 'step_1', title: 'Search facts' },
};

const step2Task: AgentTask = {
  id: 'task_step_2',
  sessionId: 'session_1',
  parentTaskId: 'task_plan',
  kind: 'planner_step',
  executor: 'react',
  status: 'running',
  version: 1,
  createdAt: 3,
  updatedAt: 3,
  metadata: { stepId: 'step_2', title: 'Verify facts' },
};

function msg(input: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'taskId' | 'role' | 'content' | 'rowId'>): AgentMessage {
  return {
    sessionId: 'session_1',
    createdAt: input.rowId,
    ...input,
  };
}

describe('planner context projection', () => {
  it('builds plan create messages without leaked step internals', () => {
    const messages = buildPlanCreateMessages({
      plannerSystemPrompt: 'planner prompt',
      goal: 'Write a report',
      now: nowContext,
      visibleRecentMessages: [
        msg({ id: 'user_1', taskId: 'task_plan', rowId: 1, role: 'user', content: 'Write a report' }),
        msg({
          id: 'react_system',
          taskId: 'task_step_1',
          rowId: 2,
          role: 'system',
          content: 'react prompt',
          metadata: { kind: 'system_prompt', executor: 'react' },
        }),
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(String(messages[0].content)).toBe('planner prompt');
    expect(String(messages[1].content)).toContain('当前日期：2026-07-09');
    expect(String(messages[1].content)).toContain('用户目标：Write a report');
    expect(String(messages[1].content)).not.toContain('react prompt');
  });

  it('builds step messages from prior step result and current step runtime only', () => {
    const messages = buildPlanStepMessages({
      reactSystemPrompt: 'react prompt',
      now: nowContext,
      goal: 'Write a report',
      plan,
      plannerTask,
      stepTask: step2Task,
      currentStep: plan.steps[1],
      tasks: [plannerTask, step1Task, step2Task],
      messages: [
        msg({ id: 'goal', taskId: 'task_plan', rowId: 1, role: 'user', content: 'Write a report' }),
        msg({
          id: 'step1_tool_call',
          taskId: 'task_step_1',
          rowId: 2,
          role: 'assistant',
          content: 'searching',
          toolCalls: [{ id: 'call_old', name: 'web_search', args: { query: 'old' } }],
        }),
        msg({
          id: 'step1_tool_result',
          taskId: 'task_step_1',
          rowId: 3,
          role: 'tool',
          content: 'old result',
          toolResult: { toolCallId: 'call_old', toolName: 'web_search', status: 'completed', result: {}, durationMs: 1 },
        }),
        msg({
          id: 'step1_result',
          taskId: 'task_step_1',
          rowId: 4,
          role: 'assistant',
          channel: 'final',
          content: 'Step 1 stable result',
          metadata: { kind: 'step_result', stepId: 'step_1' },
        }),
        msg({
          id: 'step2_tool_call',
          taskId: 'task_step_2',
          rowId: 5,
          role: 'assistant',
          content: 'checking',
          toolCalls: [{ id: 'call_current', name: 'web_search', args: { query: 'current' } }],
        }),
        msg({
          id: 'step2_tool_result',
          taskId: 'task_step_2',
          rowId: 6,
          role: 'tool',
          content: 'current result',
          toolResult: { toolCallId: 'call_current', toolName: 'web_search', status: 'completed', result: {}, durationMs: 1 },
        }),
      ],
    });

    const serialized = messages.map(message => String(message.content)).join('\n');
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(serialized).toContain('Step 1 stable result');
    expect(serialized).toContain('Cross-check facts');
    expect(serialized).not.toContain('old result');
    expect(messages.some(message => message instanceof AIMessage && String(message.content).includes('checking'))).toBe(true);
    expect(messages.some(message => message instanceof ToolMessage && String(message.content).includes('current result'))).toBe(true);
  });

  it('builds final messages from step results only', () => {
    const messages = buildPlanFinalMessages({
      finalSystemPrompt: 'final prompt',
      now: nowContext,
      goal: 'Write a report',
      plan,
      stepResults: [
        { step: plan.steps[0], result: 'Step 1 stable result' },
        { step: plan.steps[1], result: 'Step 2 stable result' },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(String(messages[1].content)).toContain('Step 1 stable result');
    expect(String(messages[1].content)).toContain('Step 2 stable result');
    expect(String(messages[1].content)).not.toContain('tool_call');
  });
});
```

- [ ] **Step 2: Run test and confirm it fails**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2
npx vitest run tests/planner-context-projection.test.ts
```

Expected:

```text
FAIL tests/planner-context-projection.test.ts
Cannot find module '../src/orchestration/planner-context-projection.js'
```

- [ ] **Step 3: Implement projection functions**

Create `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/orchestration/planner-context-projection.ts`:

```ts
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { ContextBuilder } from '../context/index.js';
import type { AgentMessage, AgentPlan, AgentPlanStep, AgentTask } from '../domain/index.js';

export interface RuntimeNowContext {
  currentDate: string;
  timeZone: string;
}

export interface BuildPlanCreateMessagesInput {
  plannerSystemPrompt: string;
  goal: string;
  now: RuntimeNowContext;
  visibleRecentMessages: AgentMessage[];
}

export interface BuildPlanStepMessagesInput {
  reactSystemPrompt: string;
  now: RuntimeNowContext;
  goal: string;
  plan: AgentPlan;
  plannerTask: AgentTask;
  stepTask: AgentTask;
  currentStep: AgentPlanStep;
  tasks: AgentTask[];
  messages: AgentMessage[];
  contextBuilder?: ContextBuilder;
}

export interface BuildPlanFinalMessagesInput {
  finalSystemPrompt: string;
  now: RuntimeNowContext;
  goal: string;
  plan: AgentPlan;
  stepResults: Array<{ step: AgentPlanStep; result: string }>;
}

const DEFAULT_CONTEXT_BUILDER = new ContextBuilder();

export function buildPlanCreateMessages(input: BuildPlanCreateMessagesInput): BaseMessage[] {
  const visibleConversation = input.visibleRecentMessages
    .filter(isUiAndModelVisibleMessage)
    .filter(message => message.metadata?.kind !== 'plan' && message.metadata?.kind !== 'planner_final')
    .slice(-8)
    .map(message => `${message.role}: ${message.content}`)
    .join('\n');

  return [
    new SystemMessage(input.plannerSystemPrompt),
    new HumanMessage([
      `当前日期：${input.now.currentDate}`,
      `当前时区：${input.now.timeZone}`,
      `用户目标：${input.goal}`,
      visibleConversation ? `可见会话摘要：\n${visibleConversation}` : '可见会话摘要：无',
      '请基于当前真实日期规划，不要沿用旧年份，除非用户明确指定时间范围。',
    ].join('\n')),
  ];
}

export function buildPlanStepMessages(input: BuildPlanStepMessagesInput): BaseMessage[] {
  const contextBuilder = input.contextBuilder ?? DEFAULT_CONTEXT_BUILDER;
  const previousResults = getPreviousStepResults(input);
  const currentRuntime = getCurrentStepRuntime(input.messages, input.stepTask.id);

  const taskBrief = [
    `当前日期：${input.now.currentDate}`,
    `当前时区：${input.now.timeZone}`,
    `用户原始目标：${input.goal}`,
    '',
    `当前计划：${input.plan.title}`,
    ...input.plan.steps.map((step, index) => `${index + 1}. ${step.title}：${step.instruction}`),
    '',
    previousResults.length > 0
      ? ['已完成步骤结果：', ...previousResults.map(item => `- ${item.title}：${item.result}`)].join('\n')
      : '已完成步骤结果：无',
    '',
    '现在只执行当前步骤。',
    `当前步骤：${input.currentStep.title}`,
    `步骤指令：${input.currentStep.instruction}`,
    '如果需要工具就调用工具；如果足以完成，则直接输出当前步骤结果。',
  ].join('\n');

  return [
    new SystemMessage(input.reactSystemPrompt),
    new HumanMessage(taskBrief),
    ...contextBuilder.build(reindexRuntimeMessages(currentRuntime)),
  ];
}

export function buildPlanFinalMessages(input: BuildPlanFinalMessagesInput): BaseMessage[] {
  const stepResults = input.stepResults.map(({ step, result }, index) => [
    `步骤 ${index + 1}：${step.title}`,
    `指令：${step.instruction}`,
    `结果：${result}`,
  ].join('\n')).join('\n\n');

  return [
    new SystemMessage(input.finalSystemPrompt),
    new HumanMessage([
      `当前日期：${input.now.currentDate}`,
      `当前时区：${input.now.timeZone}`,
      `用户目标：${input.goal}`,
      `计划标题：${input.plan.title}`,
      '计划步骤：',
      ...input.plan.steps.map((step, index) => `${index + 1}. ${step.title}：${step.instruction}`),
      '',
      '步骤执行结果：',
      stepResults,
      '',
      '请只基于步骤结果生成最终回答；不要引用未在步骤结果中确认的中间搜索失败或工具内部过程。',
    ].join('\n')),
  ];
}

export function isUiAndModelVisibleMessage(message: AgentMessage): boolean {
  if (message.role === 'system') {
    return false;
  }
  if (message.metadata?.visibility === 'internal') {
    return false;
  }
  if (message.metadata?.kind === 'system_prompt' || message.metadata?.kind === 'planner_step_input') {
    return false;
  }
  return true;
}

function getPreviousStepResults(input: BuildPlanStepMessagesInput): Array<{ title: string; result: string }> {
  const previousStepTasks = input.tasks
    .filter(task => task.parentTaskId === input.plannerTask.id && task.createdAt < input.stepTask.createdAt)
    .sort((a, b) => a.createdAt - b.createdAt);

  return previousStepTasks.flatMap(task => {
    const result = input.messages
      .filter(message =>
        message.taskId === task.id
        && message.role === 'assistant'
        && message.metadata?.kind === 'step_result'
      )
      .at(-1);
    if (!result) {
      return [];
    }
    return [{
      title: typeof task.metadata?.title === 'string' ? task.metadata.title : task.id,
      result: result.content,
    }];
  });
}

function getCurrentStepRuntime(messages: AgentMessage[], stepTaskId: string): AgentMessage[] {
  return messages
    .filter(message => message.taskId === stepTaskId)
    .filter(message => message.metadata?.kind !== 'system_prompt')
    .filter(message => message.metadata?.kind !== 'planner_step_input')
    .filter(message => message.metadata?.visibility !== 'internal')
    .filter(message => message.metadata?.kind !== 'step_result');
}

function reindexRuntimeMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message, index) => ({
    ...message,
    rowId: index + 1,
  }));
}
```

- [ ] **Step 4: Run projection tests**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2
npx vitest run tests/planner-context-projection.test.ts
```

Expected:

```text
Test Files  1 passed
Tests  3 passed
```

---

## Task 2: Use Projection for Plan Creation

**Files:**

- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/orchestration/planner-react-agent.ts`
- Test: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/planner-context-projection.test.ts`

- [ ] **Step 1: Add imports**

At the top of `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/orchestration/planner-react-agent.ts`, add:

```ts
import {
  buildPlanCreateMessages,
  buildPlanFinalMessages as projectPlanFinalMessages,
  buildPlanStepMessages,
  type RuntimeNowContext,
} from './planner-context-projection.js';
```

- [ ] **Step 2: Add runtime date helper**

Inside `PlannerReactAgent`, add:

```ts
  private getRuntimeNowContext(): RuntimeNowContext {
    const date = new Date(this.now());
    const timeZone = this.config.timeZone ?? 'Asia/Shanghai';
    return {
      currentDate: date.toLocaleDateString('en-CA', { timeZone }),
      timeZone,
    };
  }
```

If `PlannerReactAgentConfig` does not have `timeZone`, add:

```ts
  timeZone?: string;
```

to the config interface in the same file.

- [ ] **Step 3: Replace plan create context**

Replace:

```ts
const plannerContext = await this.config.contextBuilder.buildForModel({
  store: this.config.store,
  sessionId: input.sessionId,
  taskId: routedTask.id,
});
const planResult = await this.config.planner.createPlanWithUsage({
  goal: input.goal,
  messages: plannerContext.messages,
});
```

with:

```ts
const planCreateMessages = buildPlanCreateMessages({
  plannerSystemPrompt: this.config.plannerSystemPrompt ?? PLANNER_SYSTEM_PROMPT,
  goal: input.goal,
  now: this.getRuntimeNowContext(),
  visibleRecentMessages: await this.config.store.listMessages(input.sessionId),
});
const plannerContext = this.describeManualContext(planCreateMessages);
const planResult = await this.config.planner.createPlanWithUsage({
  goal: input.goal,
  messages: planCreateMessages,
});
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2
npm run typecheck
```

Expected:

```text
tsc --noEmit
```

with exit code `0`.

---

## Task 3: Persist Explicit Step Results

**Files:**

- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/orchestration/planner-react-agent.ts`
- Test: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/planner.test.ts`

- [ ] **Step 1: Update completed step message metadata**

Find the code path in `applyCoreEventToStep()` where a `CoreStepEventType.ModelOutputCompleted` event appends an assistant message for a planner step.

For step final output, persist:

```ts
metadata: {
  kind: event.channel === 'final' ? 'step_result' : 'model_output',
  stepId: step.id,
}
```

The final persisted message for each completed planner step must be:

```ts
{
  role: 'assistant',
  channel: 'final',
  metadata: { kind: 'step_result', stepId: 'step_1' }
}
```

- [ ] **Step 2: Add helper to require step result**

Inside `PlannerReactAgent`, add:

```ts
  private async loadStepResult(sessionId: string, stepTaskId: string): Promise<string | undefined> {
    return (await this.config.store.listMessages(sessionId))
      .filter(message =>
        message.taskId === stepTaskId
        && message.role === 'assistant'
        && message.channel === 'final'
        && message.metadata?.kind === 'step_result'
      )
      .at(-1)?.content;
  }
```

- [ ] **Step 3: Guard step advancement**

In `runPlanSteps()`, after `runReactStep()` returns a non-waiting result and before moving to the next step, load the step task and verify it has a step result:

```ts
const latestTasks = await this.config.store.listTasks(sessionId);
const completedStepTask = latestTasks.find(task =>
  task.parentTaskId === plannerTask.id && task.metadata?.stepId === plan.steps[index].id
);
if (!completedStepTask) {
  throw new Error(`Planner step task not found: ${plan.steps[index].id}`);
}
const stepResult = await this.loadStepResult(sessionId, completedStepTask.id);
if (!stepResult) {
  throw new Error(`Planner step completed without step_result: ${plan.steps[index].id}`);
}
```

- [ ] **Step 4: Add test for missing step result guard**

If `tests/planner.test.ts` already has a fake planner/react core fixture, add a case where the step core emits only tool result events and no final model output. Expected error:

```ts
await expect(agent.run({ sessionId: 'session_1', goal: 'research' }))
  .rejects
  .toThrow('Planner step completed without step_result');
```

If the existing fixture cannot easily simulate this, add the test after Task 4 where `continueReactStep()` is made injectable enough to test.

- [ ] **Step 5: Run planner tests**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2
npx vitest run tests/planner.test.ts tests/planner-context-projection.test.ts
```

Expected:

```text
Test Files  2 passed
```

---

## Task 4: Use Projection for Step ReAct Context

**Files:**

- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/orchestration/planner-react-agent.ts`
- Test: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/planner-context-projection.test.ts`

- [ ] **Step 1: Replace `buildReactStepContext()` internals**

Replace the manual array-building body of `buildReactStepContext()` with:

```ts
  private async buildReactStepContext(
    sessionId: string,
    plannerTask: AgentTask,
    stepTask: AgentTask,
    step: AgentPlanStep
  ): Promise<BaseMessage[]> {
    const [messages, tasks, plan] = await Promise.all([
      this.config.store.listMessages(sessionId),
      this.config.store.listTasks(sessionId),
      this.loadPlan(sessionId, plannerTask.id),
    ]);

    return buildPlanStepMessages({
      reactSystemPrompt: this.config.reactSystemPrompt ?? REACT_SYSTEM_PROMPT,
      now: this.getRuntimeNowContext(),
      goal: await this.loadPlannerGoal(sessionId, plannerTask.id),
      plan,
      plannerTask,
      stepTask,
      currentStep: step,
      tasks,
      messages,
      contextBuilder: this.config.contextBuilder,
    });
  }
```

- [ ] **Step 2: Update callers**

Wherever `buildReactStepContext(sessionId, plannerTask, stepTask)` is called, pass `step`:

```ts
const context = await this.buildReactStepContext(sessionId, plannerTask, task, step);
```

- [ ] **Step 3: Remove old local filtering code**

Delete these local concepts from the old implementation:

```ts
previousStepTaskIds
reactSystemMessages
currentStepInputMessages
previousStepMessages
currentStepRuntimeMessages
getTaskTitle usage inside buildReactStepContext
```

The only step context rules should live in `planner-context-projection.ts`.

- [ ] **Step 4: Run tests**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2
npx vitest run tests/planner-context-projection.test.ts tests/planner.test.ts
npm run typecheck
```

Expected:

```text
Test Files  2 passed
tsc --noEmit
```

---

## Task 5: Use Projection for Plan Finalization

**Files:**

- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/orchestration/planner-react-agent.ts`
- Test: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/planner-context-projection.test.ts`

- [ ] **Step 1: Replace final message builder**

Replace the body of `buildPlannerFinalMessages()` with:

```ts
  private async buildPlannerFinalMessages(
    sessionId: string,
    plannerTask: AgentTask,
    plan: AgentPlan
  ): Promise<BaseMessage[]> {
    const [messages, tasks] = await Promise.all([
      this.config.store.listMessages(sessionId),
      this.config.store.listTasks(sessionId),
    ]);

    const stepResults = plan.steps.map(step => {
      const stepTask = tasks.find(task =>
        task.parentTaskId === plannerTask.id && task.metadata?.stepId === step.id
      );
      const result = messages
        .filter(message =>
          message.taskId === stepTask?.id
          && message.role === 'assistant'
          && message.metadata?.kind === 'step_result'
        )
        .at(-1)?.content;

      if (!result) {
        throw new Error(`Missing step_result for finalization: ${step.id}`);
      }
      return { step, result };
    });

    return projectPlanFinalMessages({
      finalSystemPrompt: PLANNER_FINAL_SYSTEM_PROMPT,
      now: this.getRuntimeNowContext(),
      goal: await this.loadPlannerGoal(sessionId, plannerTask.id),
      plan,
      stepResults,
    });
  }
```

- [ ] **Step 2: Remove `finalSystem` lookup**

Keep `appendPlannerFinalSystemPrompt()` for persistence/audit if desired, but final context should use `PLANNER_FINAL_SYSTEM_PROMPT` directly, not load every system prompt from messages.

- [ ] **Step 3: Run finalization tests**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2
npx vitest run tests/planner-context-projection.test.ts tests/planner.test.ts
npm run typecheck
```

Expected:

```text
Test Files  2 passed
tsc --noEmit
```

---

## Task 6: Update Context Usage Metadata

**Files:**

- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/src/orchestration/planner-react-agent.ts`
- Test: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/planner.test.ts`

- [ ] **Step 1: Ensure context build records describe projection purpose**

For `recordContextUsage()` calls, keep current `callPurpose` values but ensure they are:

```ts
planner.route
planner.plan.create
planner.step.react
planner.plan.finalize
```

If step calls do not currently pass `planner.step.react`, update the call site in `continueReactStep()`.

- [ ] **Step 2: Add metadata source fields**

When calling `recordContextUsage()` for projected contexts, include metadata:

```ts
{
  callPurpose: 'planner.step.react',
  resultType: 'react.step',
  projection: 'plan_step',
}
```

For plan creation:

```ts
{
  callPurpose: 'planner.plan.create',
  resultType: 'planner.plan',
  projection: 'plan_create',
}
```

If `recordContextUsage()` currently accepts only `callPurpose` and `resultType`, extend its parameter type to:

```ts
metadata?: Record<string, unknown>;
```

and merge it into the context build metadata.

- [ ] **Step 3: Run context-related tests**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2
npx vitest run tests/context-snapshots.test.ts tests/planner.test.ts
npm run typecheck
```

Expected:

```text
Test Files  2 passed
tsc --noEmit
```

---

## Task 7: Verify UI and API Do Not Expose Internal Messages

**Files:**

- Modify: `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/session-view.test.ts`
- No frontend code required unless tests reveal leakage.

- [ ] **Step 1: Extend session view test for `step_result`**

In `/Users/hanljjie/Desktop/agent/agent-runtime-v2/tests/session-view.test.ts`, extend the hidden-message test with:

```ts
await store.appendMessage({
  id: 'msg_step_result',
  sessionId: 'session_1',
  taskId: 'task_1',
  role: 'assistant',
  channel: 'final',
  content: 'Stable result',
  createdAt: 170,
  metadata: { kind: 'step_result', stepId: 'step_1' },
});
```

Then expect:

```ts
expect(view.messages.map(message => message.id)).toEqual(['msg_user', 'msg_assistant', 'msg_step_result']);
```

- [ ] **Step 2: Run session view tests**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2
npx vitest run tests/session-view.test.ts
```

Expected:

```text
Test Files  1 passed
Tests  3 passed
```

or `Tests 4 passed` if another case is added.

---

## Task 8: Full Verification

**Files:**

- No source changes.

- [ ] **Step 1: Run backend tests**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2
npm test
```

Expected:

```text
Test Files  all passed
```

- [ ] **Step 2: Run backend typecheck and build**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2
npm run typecheck
npm run build
```

Expected:

```text
tsc --noEmit
tsc -p tsconfig.build.json
```

with exit code `0`.

- [ ] **Step 3: Run frontend build**

Run:

```bash
cd /Users/hanljjie/Desktop/agent/agent-runtime-v2-web
npm run build
```

Expected:

```text
vite build
✓ built
```

- [ ] **Step 4: Manual API check**

Start/restart the backend, then request a session view:

```bash
curl -s http://127.0.0.1:3000/sessions/session_a2fb0e50ad72/view \
  | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d);process.stdin.on(\"end\",()=>{const v=JSON.parse(s);console.log(v.messages.map(m=>[m.rowId,m.role,m.metadata?.kind,m.metadata?.visibility]).slice(0,20));})'
```

Expected:

- No `role: system` messages.
- No `metadata.kind: system_prompt`.
- No `metadata.kind: planner_step_input`.
- Step results, plan cards, assistant outputs, tool calls/results remain visible as appropriate.

---

## Self-Review

### Spec Coverage

- Cross-step context only uses step results: covered by Task 1 and Task 4.
- Current step runtime tail keeps tool call/result pairs: covered by Task 1 and Task 4.
- Plan create no longer reads raw session: covered by Task 2.
- Final report only reads step results: covered by Task 5.
- UI does not expose internal prompts: covered by Task 7.
- Context usage still recorded: covered by Task 6.

### Known Risks

- Existing planner tests may assert old `assistant channel=final` behavior. The migration should preserve `channel=final` while adding `metadata.kind='step_result'`.
- Some historical sessions will not have `step_result`; finalization guards will only affect new runs. Existing session view remains readable.
- `ContextBuilder.buildForModel()` remains useful for direct chat and generic compression, but should not be used for planner create/final contexts after this plan.

### Done Criteria

- Plan create context never includes ReAct system prompts.
- Step N context never includes Step N-1 tool calls/results.
- Step N context includes Step N current tool call/result pairs during resume.
- Final context contains only goal, plan, and step results.
- `/sessions/:id/view` remains UI-clean.
- All tests, typecheck, and build pass.
