import { describe, expect, it, vi } from 'vitest';
import type { AgentRealtimeEvent } from '../src/domain/index.js';
import { LoopEventHandler } from '../src/runtime/events/loop-event-handler.js';
import { LOOP_EVENT_TYPES } from '../src/runtime/loop/loop-events.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('LoopEventHandler', () => {
  it('persists a rejected output disposition before publishing its discarded projection', async () => {
    const publish = vi.fn(async (_event: AgentRealtimeEvent) => undefined);
    const setModelCallOutputDisposition = vi.fn(async () => ({}) as never);
    const handler = new LoopEventHandler({
      store: {
        models: { setCallOutputDisposition: setModelCallOutputDisposition },
      } as unknown as AgentStore,
      ownerId: 'worker_1',
      tools: [],
      publisher: { publish },
      ids: {
        eventId: () => 'event_1',
        messageId: () => 'message_1',
        toolCallId: () => 'tool_call_1',
        userInputRequestId: () => 'request_1',
      },
    });

    const feedback = await handler.handle({
      type: LOOP_EVENT_TYPES.ModelOutputRejected,
      outputId: 'output_1',
      reason: 'The durable plan is still active.',
    }, {
      sessionId: 'session_1', taskId: 'task_1', taskRunId: 'task_run_1',
    });

    expect(feedback).toBeUndefined();
    expect(setModelCallOutputDisposition).toHaveBeenCalledWith({
      taskId: 'task_1',
      outputId: 'output_1',
      disposition: 'rejected',
      reason: 'The durable plan is still active.',
    });
    expect(publish).toHaveBeenCalledWith({
      type: 'message.discarded',
      eventId: 'event_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      messageId: 'message_1',
      outputId: 'output_1',
      reason: 'The durable plan is still active.',
    });
    expect(setModelCallOutputDisposition.mock.invocationCallOrder[0])
      .toBeLessThan(publish.mock.invocationCallOrder[0]!);
  });

  it('returns control feedback only when a side-effect outcome requires recovery', async () => {
    const publish = vi.fn(async (_event: AgentRealtimeEvent) => undefined);
    const message = { id: 'message_result', sessionId: 'session_1' };
    const toolCall = { id: 'tool_call_1', sessionId: 'session_1', status: 'outcome_unknown' };
    const toolRun = { id: 'tool_run_1', taskId: 'task_1', status: 'outcome_unknown' };
    const task = { id: 'task_1', sessionId: 'session_1', status: 'recovery_required' };
    const taskRun = { id: 'task_run_1', taskId: 'task_1', status: 'interrupted' };
    const completeToolCall = vi.fn(async () => ({
      message,
      toolCall,
      toolRun,
      artifacts: [],
      recoveryRequired: { task, taskRun },
    }) as never);
    const handler = new LoopEventHandler({
      store: {
        execution: { completeToolCall },
      } as unknown as AgentStore,
      ownerId: 'worker_1',
      tools: [],
      publisher: { publish },
      ids: {
        eventId: () => 'event_1',
        messageId: () => 'message_result',
        toolCallId: () => 'tool_call_1',
        userInputRequestId: () => 'request_1',
      },
    });

    const feedback = await handler.handle({
      type: LOOP_EVENT_TYPES.ToolResultFailed,
      modelToolCallId: 'model_tool_call_1',
      toolName: 'run_shell',
      executionStarted: true,
      code: 'shell_exit_nonzero',
      message: 'The command failed.',
      durationMs: 5,
    }, {
      sessionId: 'session_1', taskId: 'task_1', taskRunId: 'task_run_1',
    });

    expect(feedback).toEqual({ recoveryRequired: task });
    expect(publish.mock.calls.map(([event]) => event.type)).toEqual([
      'message.upserted',
      'tool_call.upserted',
      'tool_run.upserted',
      'task_run.upserted',
      'task.upserted',
    ]);
  });
});
