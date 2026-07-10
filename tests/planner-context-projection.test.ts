import { describe, expect, it } from 'vitest';
import { ContextBuilder } from '../src/context/index.js';
import type { AgentMessage } from '../src/domain/index.js';
import type { PlannerPlan } from '../src/core/index.js';
import {
  buildPlanCreateMessages,
  buildPlanFinalMessages,
  buildPlanStepMessages,
  buildPlannerRouteMessages,
} from '../src/orchestration/planner-context-projection.js';

const plan: PlannerPlan = {
  id: 'plan_1',
  title: 'Research',
  steps: [
    { id: 'step_1', title: 'Search', instruction: 'Search reliable sources' },
    { id: 'step_2', title: 'Verify', instruction: 'Cross-check the evidence' },
  ],
};

const now = { currentDate: '2026-07-10', timeZone: 'Asia/Shanghai' };

describe('planner context projection', () => {
  it('builds route and plan-create contexts without step internals', () => {
    const route = buildPlannerRouteMessages({
      routerSystemPrompt: 'router prompt',
      goal: 'Write a report',
      now,
      visibleSummary: 'Previous visible answer',
    });
    const create = buildPlanCreateMessages({
      plannerSystemPrompt: 'planner prompt',
      goal: 'Write a report',
      now,
      visibleSummary: 'Previous visible answer',
    });

    expect(route.map(message => message.content)).toEqual([
      'router prompt',
      expect.stringContaining('用户目标：Write a report'),
    ]);
    expect(create.map(message => message.content)).toEqual([
      'planner prompt',
      expect.stringContaining('当前日期：2026-07-10'),
    ]);
    expect(JSON.stringify([...route, ...create])).not.toContain('planner_step_input');
  });

  it('uses previous stable results and only the current step runtime tail', () => {
    const contextBuilder = new ContextBuilder();
    const messages = buildPlanStepMessages({
      reactSystemPrompt: 'react prompt',
      goal: 'Write a report',
      now,
      plan,
      currentStep: plan.steps[1],
      previousStepResults: [
        message({
          id: 'step_1_result',
          taskId: 'task_step_1',
          rowId: 3,
          role: 'assistant',
          channel: 'final',
          messageKind: 'step_result',
          content: 'step_1 stable result',
          metadata: { stepId: 'step_1' },
        }),
      ],
      currentRuntimeTail: [
        message({
          id: 'step_2_call',
          taskId: 'task_step_2',
          rowId: 5,
          role: 'assistant',
          content: 'step_2 current assistant tool call',
          messageKind: 'tool_call',
          toolCalls: [{ id: 'call_1', name: 'web_search', args: { query: 'evidence' } }],
        }),
        message({
          id: 'step_2_result',
          taskId: 'task_step_2',
          rowId: 6,
          role: 'tool',
          content: 'step_2 current tool result',
          messageKind: 'tool_result',
          toolResult: {
            toolCallId: 'call_1',
            toolName: 'web_search',
            status: 'completed',
            result: { ok: true },
          },
        }),
      ],
      contextBuilder,
    });

    const serialized = JSON.stringify(messages);
    expect(messages).toHaveLength(4);
    expect(messages[0].content).toBe('react prompt');
    expect(messages[1].content).toEqual(expect.stringContaining('step_1 stable result'));
    expect(messages[1].content).toEqual(expect.stringContaining('现在只执行当前步骤：step_2'));
    expect(messages[2].content).toBe('step_2 current assistant tool call');
    expect(messages[3].content).toBe('step_2 current tool result');
    expect(serialized).not.toContain('step_1 raw search');
  });

  it('builds final context from plan and step results only', () => {
    const messages = buildPlanFinalMessages({
      finalSystemPrompt: 'final prompt',
      goal: 'Write a report',
      now,
      plan,
      stepResults: [
        message({
          id: 'result_1',
          taskId: 'task_step_1',
          rowId: 10,
          role: 'assistant',
          content: 'step_1 stable result',
          messageKind: 'step_result',
          metadata: { stepId: 'step_1' },
        }),
        message({
          id: 'result_2',
          taskId: 'task_step_2',
          rowId: 20,
          role: 'assistant',
          content: 'step_2 stable result',
          messageKind: 'step_result',
          metadata: { stepId: 'step_2' },
        }),
      ],
    });

    const serialized = JSON.stringify(messages);
    expect(messages).toHaveLength(2);
    expect(serialized).toContain('step_1 stable result');
    expect(serialized).toContain('step_2 stable result');
    expect(serialized.indexOf('step_1 stable result')).toBeLessThan(serialized.indexOf('step_2 stable result'));
    expect(serialized).not.toContain('raw search');
  });
});

function message(input: Omit<AgentMessage, 'sessionId' | 'createdAt'>): AgentMessage {
  return {
    ...input,
    sessionId: 'session_1',
    createdAt: input.rowId,
  };
}
