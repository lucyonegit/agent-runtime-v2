import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../src/domain/index.js';
import { projectMessageGroups } from '../src/runtime/context/helpers/message-group.helper.js';

describe('complete model message groups', () => {
  it('keeps an assistant ToolCall and all matching ToolMessages atomically', () => {
    const projection = projectMessageGroups([
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

    expect(projection.groups.map(group => group.messages.map(item => item.id))).toEqual([
      ['user_1'],
      ['call_message', 'result_a', 'result_b'],
    ]);
    expect(projection.groups[1]?.contextScope).toBe('task');
    expect(projection.excludedToolCallMessageIds).toEqual([]);
  });

  it('excludes incomplete ToolCall batches and orphan ToolMessages', () => {
    const projection = projectMessageGroups([
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
    expect(projection).toEqual({
      groups: [],
      excludedToolCallMessageIds: ['incomplete_call'],
    });
  });

  it('pairs reused model call IDs only inside their owning Task', () => {
    const projection = projectMessageGroups([
      message({
        rowId: 1,
        id: 'task_a_call',
        taskId: 'task_a',
        messageType: 'tool_call',
        toolCalls: [{ id: 'shared_id', name: 'read_file', args: {}, type: 'tool_call' }],
      }),
      message({
        rowId: 2,
        id: 'task_a_result',
        taskId: 'task_a',
        role: 'tool',
        messageType: 'tool_result',
        modelToolCallId: 'shared_id',
        toolName: 'read_file',
      }),
      message({
        rowId: 3,
        id: 'task_b_call',
        taskId: 'task_b',
        messageType: 'tool_call',
        toolCalls: [{ id: 'shared_id', name: 'write_file', args: {}, type: 'tool_call' }],
      }),
      message({
        rowId: 4,
        id: 'task_b_result',
        taskId: 'task_b',
        role: 'tool',
        messageType: 'tool_result',
        modelToolCallId: 'shared_id',
        toolName: 'write_file',
      }),
    ]);

    expect(projection.groups.map(group => group.messages.map(item => item.id))).toEqual([
      ['task_a_call', 'task_a_result'],
      ['task_b_call', 'task_b_result'],
    ]);
  });

  it('rejects ambiguous, out-of-order, and tool-name-mismatched result pairs', () => {
    const projection = projectMessageGroups([
      message({
        rowId: 1,
        id: 'early_result',
        role: 'tool',
        messageType: 'tool_result',
        modelToolCallId: 'early',
      }),
      message({
        rowId: 2,
        id: 'early_call',
        messageType: 'tool_call',
        toolCalls: [{ id: 'early', name: 'read_file', args: {}, type: 'tool_call' }],
      }),
      message({
        rowId: 3,
        id: 'wrong_name_call',
        messageType: 'tool_call',
        toolCalls: [{ id: 'wrong_name', name: 'read_file', args: {}, type: 'tool_call' }],
      }),
      message({
        rowId: 4,
        id: 'wrong_name_result',
        role: 'tool',
        messageType: 'tool_result',
        modelToolCallId: 'wrong_name',
        toolName: 'write_file',
      }),
      message({
        rowId: 5,
        id: 'ambiguous_call',
        messageType: 'tool_call',
        toolCalls: [{ id: 'ambiguous', name: 'read_file', args: {}, type: 'tool_call' }],
      }),
      message({
        rowId: 6,
        id: 'ambiguous_result_a',
        role: 'tool',
        messageType: 'tool_result',
        modelToolCallId: 'ambiguous',
      }),
      message({
        rowId: 7,
        id: 'ambiguous_result_b',
        role: 'tool',
        messageType: 'tool_result',
        modelToolCallId: 'ambiguous',
      }),
    ]);

    expect(projection.groups).toEqual([]);
    expect(projection.excludedToolCallMessageIds).toEqual([
      'early_call',
      'wrong_name_call',
      'ambiguous_call',
    ]);
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
