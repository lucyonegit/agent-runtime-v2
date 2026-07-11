import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  DefaultPlanner,
  DefaultPlanSummarizer,
} from '../src/server/runtime/default-planner.js';

describe('DefaultPlanner', () => {
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
