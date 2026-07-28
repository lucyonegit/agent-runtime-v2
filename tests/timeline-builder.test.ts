import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentToolCall } from '../src/domain/index.js';
import { TimelineBuilder } from '../src/view/timeline-builder.js';

describe('TimelineBuilder plan projection', () => {
  it('keeps a user-facing update_plan note without rendering a tool card', () => {
    const { callMessage, resultMessage, toolCall } = planExchange(
      '我先检索官方报告，再核对关键结论。'
    );

    const timeline = new TimelineBuilder().build({
      messages: [callMessage, resultMessage],
      toolCalls: [toolCall],
      artifacts: [],
    });

    expect(timeline.flat).toEqual([{
      type: 'message',
      rowId: callMessage.rowId,
      message: callMessage,
    }]);
  });

  it('continues to hide historical empty update_plan exchanges', () => {
    const { callMessage, resultMessage, toolCall } = planExchange('');

    const timeline = new TimelineBuilder().build({
      messages: [callMessage, resultMessage],
      toolCalls: [toolCall],
      artifacts: [],
    });

    expect(timeline.flat).toEqual([]);
  });
});

function planExchange(content: string): {
  callMessage: AgentMessage;
  resultMessage: AgentMessage;
  toolCall: AgentToolCall;
} {
  const callMessage: AgentMessage = {
    rowId: 1,
    id: 'message_plan_call',
    sessionId: 'session_1',
    taskId: 'task_1',
    taskRunId: 'task_run_1',
    role: 'assistant',
    messageType: 'tool_call',
    contextScope: 'task',
    visibility: 'ui',
    channel: 'normal',
    content,
    toolCalls: [{ id: 'model_plan_call', name: 'update_plan', args: {} }],
    createdAtMs: 1,
  };
  const resultMessage: AgentMessage = {
    rowId: 2,
    id: 'message_plan_result',
    sessionId: 'session_1',
    taskId: 'task_1',
    taskRunId: 'task_run_1',
    role: 'tool',
    messageType: 'tool_result',
    contextScope: 'task',
    visibility: 'ui',
    channel: 'normal',
    content: '{"title":"Research","version":1}',
    modelToolCallId: 'model_plan_call',
    toolName: 'update_plan',
    toolResult: { status: 'completed', result: { version: 1 } },
    createdAtMs: 2,
  };
  const toolCall: AgentToolCall = {
    id: 'tool_call_plan',
    sessionId: 'session_1',
    taskId: 'task_1',
    createdInTaskRunId: 'task_run_1',
    callMessageId: callMessage.id,
    resultMessageId: resultMessage.id,
    modelToolCallId: 'model_plan_call',
    toolName: 'update_plan',
    arguments: {},
    argumentsChecksum: 'checksum',
    sideEffectLevel: 'idempotent',
    idempotencyKey: 'plan-key',
    status: 'completed',
    version: 1,
    createdAtMs: 1,
    startedAtMs: 1,
    completedAtMs: 2,
    updatedAtMs: 2,
  };
  return { callMessage, resultMessage, toolCall };
}
