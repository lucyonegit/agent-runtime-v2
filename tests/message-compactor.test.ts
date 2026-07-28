import { AIMessageChunk } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentTask, AgentTaskRun } from '../src/domain/index.js';
import { MessageCompactor } from '../src/runtime/context/message-compactor.js';
import type { ModelMessageGroup } from '../src/runtime/context/types/model-input.types.js';
import type { AuditedModelFactory } from '../src/runtime/model/audited-model.factory.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('MessageCompactor lifecycle', () => {
  it('passes the Task cancellation signal to the compaction model', async () => {
    const invoke = vi.fn(async (
      _messages: unknown,
      _options?: { signal?: AbortSignal }
    ) => new AIMessageChunk('summary'));
    const replaceCompaction = vi.fn(async () => ({
      sessionId: 'session_1',
      throughMessageRowId: 1,
      summary: 'summary',
      version: 0,
      updatedAtMs: 10,
    }));
    const compactor = new MessageCompactor({
      store: { context: { replaceCompaction } } as unknown as AgentStore,
      modelFactory: {
        create: vi.fn(() => ({ invoke })),
      } as unknown as AuditedModelFactory,
      config: {
        keepRecentInputTokens: 1,
        maxToolResultTokens: 100,
        summaryMaxTokens: 100,
      },
      systemPromptVersion: 'test-v1',
      clock: { nowMs: () => 10 },
    });
    const controller = new AbortController();

    await compactor.compact({
      task: task(),
      taskRun: taskRun(),
      groups: [group('old_1', 1), group('old_2', 2), group('goal', 3)],
      signal: controller.signal,
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![1]).toMatchObject({ signal: controller.signal });
    expect(replaceCompaction).toHaveBeenCalledOnce();
  });
});

function group(id: string, rowId: number): ModelMessageGroup {
  const item: AgentMessage = {
    rowId,
    id,
    sessionId: 'session_1',
    taskId: 'task_1',
    role: 'user',
    messageType: 'user_message',
    contextScope: 'conversation',
    visibility: 'ui',
    channel: 'normal',
    content: id,
    createdAtMs: rowId,
  };
  return {
    id,
    messages: [item],
    estimatedTokens: 10,
    minRowId: rowId,
    maxRowId: rowId,
    contextScope: 'conversation',
  };
}

function task(): AgentTask {
  return {
    id: 'task_1',
    sessionId: 'session_1',
    goalMessageId: 'goal',
    status: 'running',
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function taskRun(): AgentTaskRun {
  return {
    id: 'task_run_1',
    taskId: 'task_1',
    runNo: 1,
    trigger: 'initial',
    status: 'running',
    ownerId: 'worker_1',
    ownershipExpiresAtMs: 1_000,
    startedAtMs: 1,
    updatedAtMs: 1,
  };
}
