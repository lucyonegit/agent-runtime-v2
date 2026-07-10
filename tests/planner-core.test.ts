import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { PlannerCore } from '../src/core/index.js';

describe('PlannerCore', () => {
  it('routes every goal without an optional supportsRouting branch', async () => {
    const planner = new PlannerCore({
      model: {
        invoke: async () => new AIMessage({
          content: '{"mode":"direct_answer","reason":"simple request"}',
          usage_metadata: {
            input_tokens: 12,
            output_tokens: 5,
            total_tokens: 17,
          },
        }),
      },
    });

    await expect(planner.routeGoal({ messages: [] })).resolves.toEqual({
      route: { mode: 'direct_answer', reason: 'simple request' },
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        source: 'provider',
      },
    });
  });

  it('parses a valid plan from a fenced JSON response', async () => {
    const planner = new PlannerCore({
      model: {
        invoke: async () => new AIMessage(`\`\`\`json
          {
            "id": "plan_1",
            "title": "Research",
            "steps": [
              { "id": "step_1", "title": "Search", "instruction": "Search reliable sources" },
              { "id": "step_2", "title": "Verify", "instruction": "Cross-check the evidence" }
            ]
          }
        \`\`\``),
      },
    });

    await expect(planner.createPlan({ messages: [] })).resolves.toMatchObject({
      plan: {
        id: 'plan_1',
        title: 'Research',
        steps: [
          { id: 'step_1', title: 'Search', instruction: 'Search reliable sources' },
          { id: 'step_2', title: 'Verify', instruction: 'Cross-check the evidence' },
        ],
      },
    });
  });

  it('rejects duplicate plan step ids', async () => {
    const planner = new PlannerCore({
      model: {
        invoke: async () => new AIMessage(JSON.stringify({
          id: 'plan_1',
          title: 'Research',
          steps: [
            { id: 'step_1', title: 'Search', instruction: 'Search sources' },
            { id: 'step_1', title: 'Verify', instruction: 'Verify sources' },
          ],
        })),
      },
    });

    await expect(planner.createPlan({ messages: [] })).rejects.toThrow(
      'Planner returned duplicate step id: step_1'
    );
  });

  it('rejects an empty final response', async () => {
    const planner = new PlannerCore({
      model: { invoke: async () => new AIMessage('   ') },
    });

    await expect(planner.completePlan({ messages: [] })).rejects.toThrow(
      'Planner final output is empty'
    );
  });
});
