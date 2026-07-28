import { describe, expect, it, vi } from 'vitest';
import { LOOP_EVENT_TYPES } from '../src/runtime/loop/loop-events.js';
import { RuntimeEventWriter } from '../src/runtime/events/runtime-event-writer.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('RuntimeEventWriter rejected model output', () => {
  it('publishes message.discarded for an uncommitted streaming draft', async () => {
    const publish = vi.fn(async () => undefined);
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
});
