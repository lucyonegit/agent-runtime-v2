import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentTask, AgentToolCall } from '../src/domain/index.js';
import { TaskRunResumeLoader } from '../src/runtime/execution/recovery/task-run-resume-loader.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('TaskRunResumeLoader', () => {
  it('rebuilds checkpoint counters and only pending calls from durable records', async () => {
    const callMessage = message([
      { id: 'call_pending', name: 'write_file', args: { path: 'from-model' }, type: 'tool_call' },
      { id: 'call_completed', name: 'read_file', args: { path: 'done' }, type: 'tool_call' },
    ]);
    const store = {
      execution: {
        getLatestCheckpoint: vi.fn(async () => ({
          iterationNo: 3,
          executedToolCalls: 4,
          callMessageId: callMessage.id,
        })),
      },
      sessions: {
        listMessages: vi.fn(async () => [callMessage]),
        listToolCalls: vi.fn(async () => [
          toolCall('call_pending', 'pending', { path: 'from-store' }),
          toolCall('call_completed', 'completed', { path: 'done' }),
        ]),
      },
    } as unknown as AgentStore;

    const resume = await new TaskRunResumeLoader(store).load(task());

    expect(resume).toEqual({
      iterationNo: 3,
      executedToolCalls: 4,
      pendingToolCalls: [{
        id: 'call_pending',
        name: 'write_file',
        args: { path: 'from-store' },
        type: 'tool_call',
      }],
    });
  });

  it('refuses to replay a tool call whose durable outcome is unknown', async () => {
    const callMessage = message([
      { id: 'call_unknown', name: 'run_shell', args: { command: 'deploy' }, type: 'tool_call' },
    ]);
    const store = {
      execution: {
        getLatestCheckpoint: vi.fn(async () => ({
          iterationNo: 1,
          executedToolCalls: 1,
          callMessageId: callMessage.id,
        })),
      },
      sessions: {
        listMessages: vi.fn(async () => [callMessage]),
        listToolCalls: vi.fn(async () => [
          toolCall('call_unknown', 'outcome_unknown', { command: 'deploy' }),
        ]),
      },
    } as unknown as AgentStore;

    await expect(new TaskRunResumeLoader(store).load(task())).rejects.toThrow(
      'cannot resume from outcome_unknown'
    );
  });
});

function task(): AgentTask {
  return {
    id: 'task_1',
    sessionId: 'session_1',
    goalMessageId: 'goal_1',
    status: 'running',
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function message(toolCalls: NonNullable<AgentMessage['toolCalls']>): AgentMessage {
  return {
    rowId: 2,
    id: 'message_calls',
    sessionId: 'session_1',
    taskId: 'task_1',
    role: 'assistant',
    messageType: 'tool_call',
    contextScope: 'conversation',
    visibility: 'ui',
    channel: 'normal',
    content: '',
    toolCalls,
    createdAtMs: 2,
  };
}

function toolCall(
  modelToolCallId: string,
  status: AgentToolCall['status'],
  args: Record<string, unknown>
): AgentToolCall {
  return {
    id: `tool_${modelToolCallId}`,
    sessionId: 'session_1',
    taskId: 'task_1',
    createdInTaskRunId: 'task_run_1',
    callMessageId: 'message_calls',
    modelToolCallId,
    toolName: modelToolCallId === 'call_pending' ? 'write_file' : 'run_shell',
    arguments: args,
    argumentsChecksum: 'checksum',
    sideEffectLevel: 'side_effecting',
    idempotencyKey: `task_1:${modelToolCallId}`,
    status,
    version: 1,
    createdAtMs: 2,
    updatedAtMs: 2,
  };
}
