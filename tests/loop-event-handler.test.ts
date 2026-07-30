import { describe, expect, it, vi } from 'vitest';
import type { AgentRealtimeEvent } from '../src/domain/index.js';
import { LoopEventHandler } from '../src/runtime/events/loop-event-handler.js';
import { LOOP_EVENT_TYPES } from '../src/runtime/loop/loop-events.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('LoopEventHandler', () => {
  it('publishes a streamed ToolCall preview without writing durable state', async () => {
    const publish = vi.fn(async (_event: AgentRealtimeEvent) => undefined);
    const handler = new LoopEventHandler({
      store: {} as AgentStore,
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
      type: LOOP_EVENT_TYPES.ModelToolCallPreview,
      outputId: 'output_1',
      toolCallIndex: 0,
      modelToolCallId: 'model_tool_call_1',
      toolName: 'write_file',
      observedAtMs: 123,
    }, {
      sessionId: 'session_1', taskId: 'task_1', taskRunId: 'task_run_1',
    });

    expect(feedback).toBeUndefined();
    expect(publish).toHaveBeenCalledWith({
      type: 'tool_call.preview',
      eventId: 'event_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      messageId: 'message_1',
      outputId: 'output_1',
      toolCallIndex: 0,
      modelToolCallId: 'model_tool_call_1',
      toolName: 'write_file',
      observedAtMs: 123,
    });
  });

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

  it('requests Task termination when a committed side-effect outcome is unknown', async () => {
    const publish = vi.fn(async (_event: AgentRealtimeEvent) => undefined);
    const toolCall = {
      id: 'tool_call_1',
      sessionId: 'session_1',
      status: 'outcome_unknown',
      error: { code: 'side_effect_outcome_unknown', message: 'Outcome unknown.' },
    };
    const completeToolCall = vi.fn(async () => ({
      message: { id: 'message_result', sessionId: 'session_1' },
      toolCall,
      artifacts: [],
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
      outcomeUnknown: true,
      code: 'tool_transport_lost',
      message: 'The executor connection disappeared after dispatch.',
      durationMs: 5,
    }, {
      sessionId: 'session_1', taskId: 'task_1', taskRunId: 'task_run_1',
    });

    expect(feedback).toEqual({
      stopTask: {
        code: 'tool_state_unknown',
        message: 'Outcome unknown.',
        details: { toolCallId: 'tool_call_1' },
      },
    });
    expect(completeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        executionStarted: true,
        outcomeUnknown: true,
      }),
    }));
    expect(publish.mock.calls.map(([event]) => event.type)).toEqual([
      'message.upserted',
      'tool_call.upserted',
    ]);
  });
});
