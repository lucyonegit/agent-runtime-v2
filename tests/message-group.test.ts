import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../src/domain/index.js';
import { buildCompleteMessageGroups } from '../src/runtime/context/helpers/message-group.helper.js';

describe('complete model message groups', () => {
  it('keeps an assistant ToolCall and all matching ToolMessages atomically', () => {
    const groups = buildCompleteMessageGroups([
      message({ rowId: 1, id: 'user_1', role: 'user', messageType: 'user_message' }),
      message({
        rowId: 2,
        id: 'call_message',
        role: 'assistant',
        messageType: 'tool_call',
        contextScope: 'task',
        toolCalls: [
          { id: 'model_call_a', name: 'read_file', args: { path: 'a' }, type: 'tool_call' },
          { id: 'model_call_b', name: 'read_file', args: { path: 'b' }, type: 'tool_call' },
        ],
      }),
      message({
        rowId: 3,
        id: 'result_a',
        role: 'tool',
        messageType: 'tool_result',
        contextScope: 'task',
        modelToolCallId: 'model_call_a',
      }),
      message({
        rowId: 4,
        id: 'result_b',
        role: 'tool',
        messageType: 'tool_result',
        contextScope: 'task',
        modelToolCallId: 'model_call_b',
      }),
    ]);

    expect(groups.map(group => group.messages.map(item => item.id))).toEqual([
      ['user_1'],
      ['call_message', 'result_a', 'result_b'],
    ]);
    expect(groups[1]?.contextScope).toBe('task');
  });

  it('excludes incomplete ToolCall batches and orphan ToolMessages', () => {
    const groups = buildCompleteMessageGroups([
      message({
        rowId: 1,
        id: 'incomplete_call',
        role: 'assistant',
        messageType: 'tool_call',
        toolCalls: [{ id: 'missing_result', name: 'read_file', args: {}, type: 'tool_call' }],
      }),
      message({
        rowId: 2,
        id: 'orphan_result',
        role: 'tool',
        messageType: 'tool_result',
        modelToolCallId: 'orphan',
      }),
    ]);
    expect(groups).toEqual([]);
  });
});

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'rowId'>): AgentMessage {
  return {
    sessionId: 'session_1',
    taskId: 'task_1',
    role: 'assistant',
    messageType: 'assistant_message',
    contextScope: 'conversation',
    visibility: 'ui',
    channel: 'normal',
    content: overrides.id,
    createdAtMs: overrides.rowId,
    ...overrides,
  };
}
