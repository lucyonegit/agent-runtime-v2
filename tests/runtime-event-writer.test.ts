import { describe, expect, it, vi } from 'vitest';
import { LOOP_EVENT_TYPES } from '../src/runtime/loop/loop-events.js';
import { RuntimeEventWriter } from '../src/runtime/events/runtime-event-writer.js';
import type { AgentStore } from '../src/storage/agent-store.js';
import type { AgentRealtimeEvent } from '../src/domain/index.js';

describe('RuntimeEventWriter rejected model output', () => {
  it('publishes message.discarded for an uncommitted streaming draft', async () => {
    const publish = vi.fn(async (_event: AgentRealtimeEvent) => undefined);
    const setModelCallOutputDisposition = vi.fn(async () => ({}) as never);
    const writer = new RuntimeEventWriter({
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

    const result = await writer.record({
      type: LOOP_EVENT_TYPES.ModelOutputRejected,
      outputId: 'output_1',
      reason: 'The durable plan is still active.',
    }, {
      sessionId: 'session_1', taskId: 'task_1', taskRunId: 'task_run_1',
    });

    expect(result).toEqual({ type: 'discarded_output' });
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
  });

  it('publishes recovery state when a started side effect has an unknown outcome', async () => {
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
    const writer = new RuntimeEventWriter({
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

    const result = await writer.record({
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

    expect(result).toEqual({ type: 'recovery_required', task, message });
    expect(publish.mock.calls.map(([event]) => event.type)).toEqual([
      'message.upserted',
      'tool_call.upserted',
      'tool_run.upserted',
      'task_run.upserted',
      'task.upserted',
    ]);
  });
});
