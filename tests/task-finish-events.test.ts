import { describe, expect, it } from 'vitest';
import { taskFinishEvents } from '../src/runtime/events/helpers/task-finish-events.js';

describe('Task terminal projection events', () => {
  it('publishes every changed child before the terminal Task projection', () => {
    const toolCall = { id: 'tool_call_1' };
    const toolRun = { id: 'tool_run_1' };
    const request = { id: 'input_1' };
    const taskRun = { id: 'task_run_1' };
    const task = { id: 'task_1', sessionId: 'session_1' };

    const events = taskFinishEvents({
      task,
      taskRun,
      toolCalls: [toolCall],
      toolRuns: [toolRun],
      userInputRequests: [request],
      planCleared: true,
    } as never);

    expect(events.map(event => event.type)).toEqual([
      'tool_call.upserted',
      'tool_run.upserted',
      'user_input.upserted',
      'task_run.upserted',
      'task.upserted',
      'plan.cleared',
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCall }),
      expect.objectContaining({ toolRun }),
      expect.objectContaining({ request }),
      expect.objectContaining({ taskRun }),
      expect.objectContaining({ task }),
    ]));
  });
});
