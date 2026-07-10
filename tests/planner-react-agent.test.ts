import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextBuilder } from '../src/context/index.js';
import {
  CoreStepEventType,
  type PlannerCore,
  type ReactCore,
} from '../src/core/index.js';
import { PlannerReactAgent } from '../src/orchestration/index.js';
import { FileSessionStore } from '../src/storage/index.js';

describe('PlannerReactAgent', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-planner-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates only one react root task for a direct route', async () => {
    const store = new FileSessionStore(root);
    const planner = plannerStub({ mode: 'direct_answer' });
    const agent = new PlannerReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      planner,
      directReact: coreFromRuns([[{
        type: CoreStepEventType.ModelOutputCompleted,
        outputId: 'direct_output',
        channel: 'final',
        content: '你好，我可以帮你。',
      }]]),
      stepReact: coreFromRuns([]),
      sandboxRoot: root,
      ids: sequenceIds(),
      clock: tickingClock(),
    });

    const result = await agent.run({ sessionId: 'session_1', goal: '你好' });

    expect(result.status).toBe('completed');
    const tasks = await store.listTasks('session_1');
    expect(tasks).toMatchObject([
      {
        kind: 'react',
        executor: 'react',
        status: 'completed',
      },
    ]);
    expect(tasks[0].parentTaskId).toBeUndefined();
    expect((await store.listMessages('session_1')).filter(message => message.role === 'user'))
      .toHaveLength(1);
  });

  it('creates a planner root and sequential step tasks with stable results', async () => {
    const store = new FileSessionStore(root);
    const planner = plannerStub({ mode: 'plan' });
    const agent = new PlannerReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      planner,
      directReact: coreFromRuns([]),
      stepReact: coreFromRuns([
        stepResultEvents('step_1', 'Found primary sources'),
        stepResultEvents('step_2', 'Verified the evidence'),
      ]),
      sandboxRoot: root,
      ids: sequenceIds(),
      clock: tickingClock(),
    });

    const result = await agent.run({ sessionId: 'session_1', goal: '调研并写报告' });

    expect(result.status).toBe('completed');
    expect(await store.listTasks('session_1')).toMatchObject([
      { kind: 'planner', executor: 'planner', status: 'completed' },
      {
        kind: 'planner_step',
        executor: 'react',
        status: 'completed',
        metadata: { stepId: 'step_1', planId: 'plan_1' },
      },
      {
        kind: 'planner_step',
        executor: 'react',
        status: 'completed',
        metadata: { stepId: 'step_2', planId: 'plan_1' },
      },
    ]);

    const messages = await store.listMessages('session_1');
    expect(messages.filter(message => message.messageKind === 'plan')).toHaveLength(1);
    expect(messages.filter(message => message.messageKind === 'step_result')).toMatchObject([
      { content: 'Found primary sources', metadata: { stepId: 'step_1' } },
      { content: 'Verified the evidence', metadata: { stepId: 'step_2' } },
    ]);
    expect(messages.filter(message => message.messageKind === 'planner_final')).toMatchObject([
      { content: 'Final report from stable step results.' },
    ]);
    expect((await store.listContextBuilds('session_1')).map(build => build.callPurpose)).toEqual([
      'planner.route',
      'planner.plan.create',
      'planner.step.react',
      'planner.step.react',
      'planner.plan.finalize',
    ]);
    expect(planner.completePlan).toHaveBeenCalledTimes(1);
  });

  it('waits for every HITL answer and resumes the same step from a new agent instance', async () => {
    const store = new FileSessionStore(root);
    const planner = plannerStub({ mode: 'plan', stepCount: 1 });
    const ids = sequenceIds();
    const clock = tickingClock();
    let coreRuns = 0;
    const stepReact = {
      run: async function* () {
        coreRuns += 1;
        const events = coreRuns === 1
          ? hitlEvents()
          : stepResultEvents('step_1', 'Completed after both answers');
        for (const event of events) {
          yield event;
        }
      },
    } as unknown as ReactCore;
    const createAgent = () => new PlannerReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      planner,
      directReact: coreFromRuns([]),
      stepReact,
      sandboxRoot: root,
      ids,
      clock,
    });

    const waiting = await createAgent().run({ sessionId: 'session_hitl', goal: '需要用户选择的调查' });
    expect(waiting.status).toBe('waiting_user_input');
    const requests = await store.listInputRequests('session_hitl');
    expect(requests).toHaveLength(2);
    expect(coreRuns).toBe(1);
    expect(await store.listTasks('session_hitl')).toMatchObject([
      { kind: 'planner', status: 'waiting_user_input' },
      { kind: 'planner_step', status: 'waiting_user_input' },
    ]);

    const partial = await createAgent().answerInputRequest({
      sessionId: 'session_hitl',
      requestId: requests[0].id,
      value: 'A',
    });
    expect(partial.status).toBe('waiting_user_input');
    expect(partial.waitingRequestIds).toEqual([requests[1].id]);
    expect(coreRuns).toBe(1);

    const completed = await createAgent().answerInputRequest({
      sessionId: 'session_hitl',
      requestId: requests[1].id,
      value: 'B',
    });
    expect(completed.status).toBe('completed');
    expect(coreRuns).toBe(2);
    expect(await store.listTasks('session_hitl')).toMatchObject([
      { kind: 'planner', status: 'completed' },
      { kind: 'planner_step', status: 'completed' },
    ]);
    expect((await store.listMessages('session_hitl')).filter(message => message.messageKind === 'step_result'))
      .toMatchObject([{ content: 'Completed after both answers' }]);
  });
});

function plannerStub(input: {
  mode: 'direct_answer' | 'plan';
  stepCount?: 1 | 2;
}): PlannerCore {
  const steps = [
    { id: 'step_1', title: 'Search', instruction: 'Search primary sources' },
    { id: 'step_2', title: 'Verify', instruction: 'Verify the evidence' },
  ].slice(0, input.stepCount ?? 2);
  return {
    routeGoal: vi.fn(async () => ({
      route: { mode: input.mode, reason: input.mode === 'plan' ? 'complex' : 'simple' },
    })),
    createPlan: vi.fn(async () => ({
      plan: {
        id: 'plan_1',
        title: 'Research plan',
        steps,
      },
    })),
    completePlan: vi.fn(async () => ({
      content: 'Final report from stable step results.',
    })),
  } as unknown as PlannerCore;
}

function hitlEvents() {
  return [
    {
      type: CoreStepEventType.ModelOutputCompleted,
      outputId: 'output_hitl',
      channel: 'normal' as const,
      content: 'Please choose both values.',
      toolCalls: [
        { id: 'call_a', name: 'request_user_input', args: { prompt: 'Choose A' } },
        { id: 'call_b', name: 'request_user_input', args: { prompt: 'Choose B' } },
      ],
    },
    {
      type: CoreStepEventType.ToolInputRequired,
      toolCallId: 'call_a',
      toolName: 'request_user_input',
      request: {
        source: 'tool' as const,
        resumeMode: 'answer_as_tool_result' as const,
        prompt: 'Choose A',
        input: { type: 'text' as const },
      },
    },
    {
      type: CoreStepEventType.ToolInputRequired,
      toolCallId: 'call_b',
      toolName: 'request_user_input',
      request: {
        source: 'tool' as const,
        resumeMode: 'answer_as_tool_result' as const,
        prompt: 'Choose B',
        input: { type: 'text' as const },
      },
    },
  ];
}

function stepResultEvents(stepId: string, summary: string) {
  const toolCallId = `call_${stepId}`;
  return [
    {
      type: CoreStepEventType.ModelOutputCompleted,
      outputId: `output_${stepId}`,
      channel: 'normal' as const,
      content: '',
      toolCalls: [{
        id: toolCallId,
        name: 'submit_step_result',
        args: { stepId, summary },
      }],
    },
    {
      type: CoreStepEventType.ToolResultCompleted,
      toolCallId,
      toolName: 'submit_step_result',
      content: JSON.stringify({ type: 'step_result_submitted', stepId, summary }),
      result: { type: 'step_result_submitted', stepId, summary },
      durationMs: 1,
    },
  ];
}

function coreFromRuns(runs: Array<Array<unknown>>): ReactCore {
  let index = 0;
  return {
    run: async function* () {
      const events = runs[index] ?? [];
      index += 1;
      for (const event of events) {
        yield event;
      }
    },
  } as unknown as ReactCore;
}

function sequenceIds() {
  let index = 0;
  return (prefix: string) => `${prefix}_${++index}`;
}

function tickingClock() {
  let now = 100;
  return () => ++now;
}
