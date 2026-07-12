import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  DefaultPlanner,
  DefaultPlanSummarizer,
} from '../src/server/runtime/default-planner.js';

describe('DefaultPlanner', () => {
  it('does not let complex research and build goals degrade to direct', async () => {
    const planner = plannerWithRouteResponse('{"strategy":"direct"}');

    await expect(planner.route({
      goal: '调查一下萧山机场UFO事件前因后果，写一个分析报告1000字',
    })).resolves.toBe('planned');
    await expect(planner.route({ goal: '写一个todo应用' })).resolves.toBe('planned');
  });

  it('keeps genuinely simple goals direct', async () => {
    const planner = plannerWithRouteResponse('{"strategy":"direct"}');

    await expect(planner.route({ goal: '你好' })).resolves.toBe('direct');
    await expect(planner.route({ goal: '现在几点了？' })).resolves.toBe('direct');
  });

  it('instructs the model to route by execution stages instead of deliverable count', async () => {
    const invoke = vi.fn(async (_input: unknown) => new AIMessage('{"strategy":"direct"}'));
    const planner = new DefaultPlanner({ invoke } as never, { invoke: vi.fn() } as never);

    await planner.route({ goal: '你好' });

    const messages = invoke.mock.calls[0]?.[0] as Array<SystemMessage | HumanMessage>;
    expect(messages[0]?.text).toContain('execution complexity');
    expect(messages[0]?.text).toContain('one final report is still planned');
    expect(messages[0]?.text).toContain('build a todo application');
  });

  it('accepts fenced route JSON and rejects invalid decisions', async () => {
    await expect(plannerWithRouteResponse('```json\n{"strategy":"planned"}\n```')
      .route({ goal: '普通任务' })).resolves.toBe('planned');
    await expect(plannerWithRouteResponse('I think direct')
      .route({ goal: '普通任务' })).rejects.toThrow('Invalid planner route response');
  });

  it('provides temporal context and forbids invented research facts', async () => {
    const invoke = vi.fn(async (_input: unknown) => new AIMessage(JSON.stringify({
      title: 'Recent news report',
      steps: [{ title: 'Search', instruction: 'Discover current sources.' }],
    })));
    const planner = new DefaultPlanner({ invoke } as never, { invoke } as never);

    await expect(planner.createPlan({
      goal: 'Research three recent reports.',
      currentDate: '2026-07-11',
      timezone: 'Asia/Shanghai',
      availableTools: ['web_search', 'browse_url'],
    })).resolves.toEqual({
      title: 'Recent news report',
      steps: [{ title: 'Search', instruction: 'Discover current sources.' }],
    });

    const messages = invoke.mock.calls[0]?.[0] as Array<SystemMessage | HumanMessage> | undefined;
    expect(messages?.[0]).toBeInstanceOf(SystemMessage);
    expect(messages?.[0]?.text).toContain('2026-07-11');
    expect(messages?.[0]?.text).toContain('Asia/Shanghai');
    expect(messages?.[0]?.text).toContain('web_search, browse_url');
    expect(messages?.[0]?.text).toContain('Do not invent facts, sources, dates, URLs, evidence, or conclusions');
    expect(messages?.[0]?.text).toContain('Never remove or contradict an explicit user requirement');
    expect(messages?.[0]?.text).toContain('Do not add unrequested deliverables or constraints');
    expect(messages?.[0]?.text).toContain('Do not create or write files unless the user requested it');
    expect(messages?.[0]?.text).toContain('Each step instruction may contain only actions and acceptance criteria');
    expect(messages?.[0]?.text).toContain('must not contain possible');
    expect(messages?.[0]?.text).toContain('absent from the available runtime tools');
    expect(messages?.[0]?.text).toContain('Collecting context or user input is preparation, not completion');
    expect(messages?.[0]?.text).toContain('The final step must perform and deliver the requested outcome');
    expect(messages?.[1]).toBeInstanceOf(HumanMessage);
  });

  it('repairs a final answer that promises work after the Job ends', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(new AIMessage('接下来，我将为你抽取三张牌，请稍候。'))
      .mockResolvedValueOnce(new AIMessage('你抽到的三张牌是：恋人、力量、星星。'));
    const summarizer = new DefaultPlanSummarizer({ invoke } as never);

    await expect(summarizer.summarize({
      originalGoal: '我想抽个塔罗',
      plan: {
        id: 'plan_1', sessionId: 'session_1', jobId: 'job_1', title: '塔罗', goal: '抽牌',
        status: 'completed', version: 1, createdAtMs: 1, updatedAtMs: 2, completedAtMs: 2,
      },
      steps: [],
      outputs: [],
      currentDate: '2026-07-11',
      timezone: 'Asia/Shanghai',
    })).resolves.toBe('你抽到的三张牌是：恋人、力量、星星。');

    expect(invoke).toHaveBeenCalledTimes(2);
    const firstMessages = invoke.mock.calls[0]?.[0] as Array<SystemMessage | HumanMessage>;
    expect(firstMessages[0]?.text).toContain('ends the Job immediately');
    expect(firstMessages[0]?.text).toContain('Never promise future work');
    const repairMessages = invoke.mock.calls[1]?.[0] as Array<SystemMessage | HumanMessage>;
    expect(repairMessages[0]?.text).toContain('invalid because it promises work after completion');
  });
});

function plannerWithRouteResponse(content: string): DefaultPlanner {
  return new DefaultPlanner({
    invoke: vi.fn(async () => new AIMessage(content)),
  } as never, { invoke: vi.fn() } as never);
}
