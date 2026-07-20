import { describe, expect, it, vi } from 'vitest';
import { LOOP_EVENT_TYPES } from '../src/agent-loop/loop-events.js';
import { RuntimeEventWriter } from '../src/runtime/runtime-event-writer.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('RuntimeEventWriter rejected model output', () => {
  it('publishes message.discarded for an uncommitted streaming draft', async () => {
    const publish = vi.fn(async () => undefined);
    const setModelCallOutputDisposition = vi.fn(async () => ({}) as never);
    const writer = new RuntimeEventWriter({
      store: { setModelCallOutputDisposition } as unknown as AgentStore,
      workerId: 'worker_1',
      tools: [],
      publisher: { publish },
      ids: {
        eventId: () => 'event_1',
        messageId: () => 'message_1',
        toolInvocationId: () => 'invocation_1',
        userInputRequestId: () => 'request_1',
      },
    });

    const result = await writer.record({
      type: LOOP_EVENT_TYPES.ModelOutputRejected,
      outputId: 'output_1',
      reason: 'The durable plan is still active.',
    }, {
      sessionId: 'session_1', jobId: 'job_1', attemptId: 'attempt_1',
    });

    expect(result).toEqual({ type: 'discarded_output' });
    expect(setModelCallOutputDisposition).toHaveBeenCalledWith({
      jobId: 'job_1',
      outputId: 'output_1',
      disposition: 'rejected',
      reason: 'The durable plan is still active.',
    });
    expect(publish).toHaveBeenCalledWith({
      type: 'message.discarded',
      eventId: 'event_1',
      sessionId: 'session_1',
      jobId: 'job_1',
      messageId: 'message_1',
      outputId: 'output_1',
      reason: 'The durable plan is still active.',
    });
  });
});
