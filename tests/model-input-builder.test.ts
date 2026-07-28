import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentTask } from '../src/domain/index.js';
import { ModelInputBuilder } from '../src/runtime/context/model-input-builder.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('ModelInputBuilder', () => {
  it('builds one ReAct context from conversation messages plus current-Task messages', async () => {
    const messages: AgentMessage[] = [
      message({ rowId: 1, id: 'old_user', taskId: 'task_old', role: 'user', messageType: 'user_message' }),
      message({ rowId: 2, id: 'old_answer', taskId: 'task_old', content: 'old answer' }),
      message({
        rowId: 3,
        id: 'old_task_call',
        taskId: 'task_old',
        messageType: 'tool_call',
        contextScope: 'task',
        toolCalls: [{ id: 'old_model_call', name: 'read_file', args: {}, type: 'tool_call' }],
      }),
      message({
        rowId: 4,
        id: 'old_task_result',
        taskId: 'task_old',
        role: 'tool',
        messageType: 'tool_result',
        contextScope: 'task',
        modelToolCallId: 'old_model_call',
      }),
      message({
        rowId: 5,
        id: 'goal',
        taskId: 'task_current',
        role: 'user',
        messageType: 'user_message',
        content: 'current goal',
      }),
      message({
        rowId: 6,
        id: 'current_call',
        taskId: 'task_current',
        messageType: 'tool_call',
        contextScope: 'task',
        toolCalls: [{ id: 'current_model_call', name: 'read_file', args: {}, type: 'tool_call' }],
      }),
      message({
        rowId: 7,
        id: 'current_result',
        taskId: 'task_current',
        role: 'tool',
        messageType: 'tool_result',
        contextScope: 'task',
        modelToolCallId: 'current_model_call',
        content: 'x'.repeat(2_000),
      }),
      message({ rowId: 8, id: 'internal_none', taskId: 'task_current', contextScope: 'none' }),
    ];
    const loadInputSnapshot = vi.fn(async () => ({
      messages,
      activePlan: {
        sessionId: 'session_1', taskId: 'task_current', title: 'Current plan',
        steps: [{ step: 'Inspect', status: 'in_progress' as const }],
        version: 0, createdAtMs: 1, updatedAtMs: 1,
      },
    }));
    const store = {
      context: { loadInputSnapshot },
    } as unknown as AgentStore;
    const builder = new ModelInputBuilder({
      store,
      systemPrompt: 'system policy',
      systemPromptVersion: 'task-agent-v1',
      promptId: 'task-agent',
      promptVersion: 1,
      inputTokenLimit: 100_000,
      reservedOutputTokens: 4_096,
      contextConfig: {
        keepRecentInputTokens: 8_000,
        maxToolResultTokens: 20,
        summaryMaxTokens: 1_000,
      },
      toolSchemas: [],
      getStableContext: async () => 'stable environment',
    });

    const input = await builder.previewTask(task());

    expect(input.includedMessageIds).toEqual([
      'old_user', 'old_answer', 'goal', 'current_call', 'current_result',
    ]);
    expect(input.includedMessageIds).not.toContain('old_task_call');
    expect(input.includedMessageIds).not.toContain('internal_none');
    expect(input.projectedToolResultMessageIds).toEqual(['current_result']);
    expect(input.messages.map(item => item.text).join('\n')).toContain('Current plan');
    expect(input.messages.map(item => item.getType())).toEqual([
      'system', 'system', 'human', 'ai', 'human', 'ai', 'tool', 'system',
    ]);
    expect(input.inputManifest.purpose).toBe('task.react');
    expect(loadInputSnapshot).toHaveBeenCalledOnce();
  });
});

function task(): AgentTask {
  return {
    id: 'task_current',
    sessionId: 'session_1',
    goalMessageId: 'goal',
    status: 'running',
    version: 1,
    createdAtMs: 5,
    updatedAtMs: 5,
  };
}

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'rowId'>): AgentMessage {
  return {
    sessionId: 'session_1',
    taskId: 'task_current',
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
