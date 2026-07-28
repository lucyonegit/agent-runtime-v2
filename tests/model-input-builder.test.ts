import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentTask, AgentTaskRun } from '../src/domain/index.js';
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
    expect(input.estimatedTokens).toBe(
      input.inputManifest.estimatedBreakdown.system
      + input.inputManifest.estimatedBreakdown.tools
      + input.inputManifest.estimatedBreakdown.summaries
      + input.inputManifest.estimatedBreakdown.messages
    );
    expect(loadInputSnapshot).toHaveBeenCalledOnce();
    expect(loadInputSnapshot).toHaveBeenCalledWith({
      sessionId: 'session_1',
      taskId: 'task_current',
      goalMessageId: 'goal',
    });
  });

  it('counts assistant tool-call arguments in the model input budget', async () => {
    const messages: AgentMessage[] = [
      message({
        rowId: 1,
        id: 'goal',
        role: 'user',
        messageType: 'user_message',
        content: 'Use the tool result',
      }),
      message({
        rowId: 2,
        id: 'call',
        messageType: 'tool_call',
        contextScope: 'task',
        toolCalls: [{
          id: 'model_call',
          name: 'write_file',
          args: { content: 'x'.repeat(20_000) },
          type: 'tool_call',
        }],
      }),
      message({
        rowId: 3,
        id: 'result',
        role: 'tool',
        messageType: 'tool_result',
        contextScope: 'task',
        modelToolCallId: 'model_call',
        content: 'written',
      }),
    ];
    const builder = new ModelInputBuilder({
      store: {
        context: { loadInputSnapshot: vi.fn(async () => ({ messages })) },
      } as unknown as AgentStore,
      systemPrompt: 'system policy',
      systemPromptVersion: 'task-agent-v1',
      promptId: 'task-agent',
      promptVersion: 1,
      inputTokenLimit: 1_000,
      reservedOutputTokens: 100,
      contextConfig: {
        keepRecentInputTokens: 8_000,
        maxToolResultTokens: 1_000,
        summaryMaxTokens: 1_000,
      },
      toolSchemas: [],
      getStableContext: async () => 'stable environment',
    });

    await expect(builder.buildForTask(task(), taskRun())).rejects.toMatchObject({
      code: 'model_input_too_large',
    });
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

function taskRun(): AgentTaskRun {
  return {
    id: 'task_run_current',
    taskId: 'task_current',
    runNo: 1,
    trigger: 'initial',
    status: 'running',
    ownerId: 'worker_1',
    ownershipExpiresAtMs: 1_000,
    startedAtMs: 1,
    updatedAtMs: 1,
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
