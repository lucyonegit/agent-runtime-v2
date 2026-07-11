import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { DefaultPlanner } from '../src/server/runtime/default-planner.js';

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
    expect(messages?.[1]).toBeInstanceOf(HumanMessage);
  });
});
