import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentContextSnapshotKind, AgentContextSnapshotStatus } from '../src/domain/index.js';
import { FileSessionStore } from '../src/storage/index.js';

describe('FileSessionStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a session, task, and ordered messages', async () => {
    const store = new FileSessionStore(root);
    const session = await store.createSession({
      id: 'session_1',
      mode: 'planner_react',
      now: 100,
      title: 'Test session',
    });
    const task = await store.createTask({
      id: 'task_1',
      sessionId: session.id,
      kind: 'react',
      executor: 'react',
      now: 110,
    });

    const first = await store.appendMessage({
      id: 'msg_1',
      sessionId: session.id,
      taskId: task.id,
      role: 'user',
      content: 'hello',
      createdAt: 120,
    });
    const second = await store.appendMessage({
      id: 'msg_2',
      sessionId: session.id,
      taskId: task.id,
      role: 'assistant',
      channel: 'final',
      content: 'hi',
      createdAt: 130,
    });

    expect(first.rowId).toBe(1);
    expect(second.rowId).toBe(2);
    expect(first).toMatchObject({ messageKind: 'message', visibility: 'ui' });
    expect(second).toMatchObject({ messageKind: 'message', visibility: 'ui' });
    await expect(store.getSession('session_1')).resolves.toMatchObject({ id: 'session_1' });
    await expect(store.listTasks('session_1')).resolves.toHaveLength(1);
    await expect(store.listMessages('session_1')).resolves.toMatchObject([
      { id: 'msg_1', rowId: 1 },
      { id: 'msg_2', rowId: 2 },
    ]);
    await expect(store.listMessagesAfterRowId('session_1', first.rowId)).resolves.toMatchObject([
      { id: 'msg_2', rowId: 2 },
    ]);
  });

  it('normalizes message kind and visibility from persisted message shape', async () => {
    const store = new FileSessionStore(root);
    await store.createSession({ id: 'session_1', mode: 'planner_react', now: 100 });
    await store.createTask({ id: 'task_1', sessionId: 'session_1', kind: 'planner_step', now: 110 });

    const systemPrompt = await store.appendMessage({
      id: 'msg_system',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'system',
      content: 'React system prompt',
      createdAt: 120,
      metadata: { kind: 'system_prompt' },
    });
    const stepInput = await store.appendMessage({
      id: 'msg_step_input',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'user',
      content: 'Only run this step',
      createdAt: 130,
      metadata: { kind: 'planner_step_input', visibility: 'internal' },
    });
    const toolCall = await store.appendMessage({
      id: 'msg_tool_call',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'assistant',
      channel: 'normal',
      content: 'Searching',
      toolCalls: [{ id: 'call_1', name: 'web_search', args: { query: 'x' } }],
      createdAt: 140,
    });
    const toolResult = await store.appendMessage({
      id: 'msg_tool_result',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'tool',
      content: '{}',
      toolResult: { toolCallId: 'call_1', toolName: 'web_search', status: 'completed', result: {} },
      createdAt: 150,
    });

    expect(systemPrompt).toMatchObject({ messageKind: 'system_prompt', visibility: 'internal' });
    expect(stepInput).toMatchObject({ messageKind: 'planner_step_input', visibility: 'internal' });
    expect(toolCall).toMatchObject({ messageKind: 'tool_call', visibility: 'ui' });
    expect(toolResult).toMatchObject({ messageKind: 'tool_result', visibility: 'ui' });
  });

  it('updates task status and input request answers', async () => {
    const store = new FileSessionStore(root);
    await store.createSession({ id: 'session_1', mode: 'planner_react', now: 100 });
    await store.createTask({
      id: 'task_1',
      sessionId: 'session_1',
      kind: 'react',
      now: 110,
    });
    const request = await store.createInputRequest({
      id: 'input_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      source: 'tool',
      toolCallId: 'call_1',
      toolName: 'choose',
      resumeMode: 'answer_as_tool_result',
      prompt: 'Choose one',
      input: { type: 'single_choice', options: [{ label: 'A', value: 'a' }] },
      now: 120,
    });

    await store.updateTask('task_1', {
      status: 'waiting_user_input',
      waitingRequestId: request.id,
      updatedAt: 130,
    });
    await store.answerInputRequest('input_1', {
      value: 'a',
      messageId: 'msg_answer',
      answeredAt: 140,
    });

    const [task] = await store.listTasks('session_1');
    const [answered] = await store.listInputRequests('session_1');

    expect(task).toMatchObject({
      status: 'waiting_user_input',
      waitingRequestId: 'input_1',
    });
    expect(answered).toMatchObject({
      status: 'answered',
      answer: { value: 'a', messageId: 'msg_answer' },
    });
  });

  it('allows only one active root task per session', async () => {
    const store = new FileSessionStore(root);
    await store.createSession({ id: 'session_1', mode: 'planner_react', now: 100 });
    await store.createTask({
      id: 'task_1',
      sessionId: 'session_1',
      kind: 'react',
      now: 110,
    });

    await expect(store.createTask({
      id: 'task_2',
      sessionId: 'session_1',
      kind: 'react',
      now: 120,
    })).rejects.toThrow('Active root task already exists for session: session_1');

    await expect(store.createTask({
      id: 'task_child',
      sessionId: 'session_1',
      parentTaskId: 'task_1',
      kind: 'planner_step',
      now: 130,
    })).resolves.toMatchObject({
      id: 'task_child',
      parentTaskId: 'task_1',
    });

    await store.updateTask('task_1', {
      status: 'completed',
      updatedAt: 140,
    });
    await expect(store.createTask({
      id: 'task_3',
      sessionId: 'session_1',
      kind: 'react',
      now: 150,
    })).resolves.toMatchObject({ id: 'task_3' });
  });

  it('rejects stale task updates', async () => {
    const store = new FileSessionStore(root);
    await store.createSession({ id: 'session_1', mode: 'planner_react', now: 100 });
    const created = await store.createTask({
      id: 'task_1',
      sessionId: 'session_1',
      kind: 'react',
      now: 110,
    });

    await store.updateTask('task_1', {
      ...created,
      status: 'running',
      updatedAt: 120,
    });

    await expect(store.updateTask('task_1', {
      ...created,
      status: 'failed',
      updatedAt: 130,
      error: { message: 'stale update', failedAt: 130 },
    })).rejects.toThrow('Task was updated concurrently: task_1');
  });

  it('rejects answering an input request that is not pending', async () => {
    const store = new FileSessionStore(root);
    await store.createSession({ id: 'session_1', mode: 'planner_react', now: 100 });
    await store.createTask({
      id: 'task_1',
      sessionId: 'session_1',
      kind: 'react',
      now: 110,
    });
    await store.createInputRequest({
      id: 'input_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      source: 'tool',
      toolCallId: 'call_1',
      toolName: 'choose',
      resumeMode: 'answer_as_tool_result',
      prompt: 'Choose one',
      input: { type: 'single_choice', options: [{ label: 'A', value: 'a' }] },
      now: 120,
    });

    await store.answerInputRequest('input_1', {
      value: 'a',
      messageId: 'msg_answer',
      answeredAt: 130,
    });

    await expect(store.answerInputRequest('input_1', {
      value: 'b',
      messageId: 'msg_answer_2',
      answeredAt: 140,
    })).rejects.toThrow('Input request is not pending: input_1');

    await expect(store.listInputRequests('session_1')).resolves.toMatchObject([
      {
        id: 'input_1',
        status: 'answered',
        answer: { value: 'a', messageId: 'msg_answer' },
      },
    ]);
  });

  it('stores and replaces active context snapshots', async () => {
    const store = new FileSessionStore(root);
    const now = 1000;
    await store.createSession({ id: 'session_ctx', mode: 'planner_react', now });

    const first = await store.createContextSnapshot({
      id: 'snap_1',
      sessionId: 'session_ctx',
      kind: AgentContextSnapshotKind.RollingSummary,
      status: AgentContextSnapshotStatus.Active,
      sourceRowIdStart: 1,
      sourceRowIdEnd: 10,
      summary: 'first summary',
      summaryFormat: 'markdown',
      sourceMessageCount: 10,
      compressionPromptVersion: 'v1',
      now,
    });

    expect(first.status).toBe(AgentContextSnapshotStatus.Active);

    const second = await store.replaceActiveContextSnapshot({
      id: 'snap_2',
      sessionId: 'session_ctx',
      kind: AgentContextSnapshotKind.RollingSummary,
      sourceRowIdStart: 1,
      sourceRowIdEnd: 20,
      summary: 'second summary',
      summaryFormat: 'markdown',
      sourceMessageCount: 20,
      compressionPromptVersion: 'v1',
      supersedesSnapshotId: 'snap_1',
      now: now + 1,
    });

    expect(second.status).toBe(AgentContextSnapshotStatus.Active);
    await expect(store.getActiveContextSnapshot('session_ctx')).resolves.toMatchObject({
      id: 'snap_2',
      summary: 'second summary',
    });
    await expect(store.listContextSnapshots('session_ctx')).resolves.toMatchObject([
      { id: 'snap_1', status: AgentContextSnapshotStatus.Superseded },
      { id: 'snap_2', status: AgentContextSnapshotStatus.Active },
    ]);
  });

  it('stores context builds and aggregates session token stats from provider usage', async () => {
    const store = new FileSessionStore(root);
    const now = 2000;
    await store.createSession({ id: 'session_usage', mode: 'planner_react', now });
    await store.createTask({
      id: 'task_usage',
      sessionId: 'session_usage',
      kind: 'react',
      now,
    });

    const build = await store.createContextBuild({
      id: 'ctx_build_1',
      sessionId: 'session_usage',
      taskId: 'task_usage',
      taskKind: 'react',
      executor: 'react',
      callPurpose: 'react.loop',
      model: 'qwen-test',
      strategy: 'full',
      maxContextTokens: 100,
      reservedOutputTokens: 20,
      estimatedInputTokens: 40,
      includedRowIdStart: 1,
      includedRowIdEnd: 2,
      breakdown: { recentMessages: 40, reservedOutput: 20 },
      now,
    });

    expect(build.usageSource).toBe('estimated');
    expect(build.contextUsageRatio).toBe(0.4);
    expect(build).toMatchObject({
      taskKind: 'react',
      executor: 'react',
      callPurpose: 'react.loop',
    });

    const completed = await store.completeContextBuild('ctx_build_1', {
      usage: {
        inputTokens: 50,
        outputTokens: 12,
        totalTokens: 62,
        source: 'provider',
      },
      outputId: 'out_1',
      outputChannel: 'normal',
      resultType: 'tool_calls',
      toolCallCount: 2,
      toolNames: ['web_search', 'browse_url'],
      completedAt: now + 1,
    });

    expect(completed).toMatchObject({
      actualInputTokens: 50,
      actualOutputTokens: 12,
      actualTotalTokens: 62,
      usageSource: 'provider',
      contextUsageRatio: 0.5,
      outputId: 'out_1',
      outputChannel: 'normal',
      resultType: 'tool_calls',
      toolCallCount: 2,
      toolNames: ['web_search', 'browse_url'],
    });

    await expect(store.getSessionTokenStats('session_usage')).resolves.toMatchObject({
      sessionId: 'session_usage',
      totalModelCalls: 1,
      totalEstimatedInputTokens: 40,
      totalActualInputTokens: 50,
      totalActualOutputTokens: 12,
      totalTokens: 62,
      latestContextBuildId: 'ctx_build_1',
      latestContextUsageRatio: 0.5,
      warningLevel: 'normal',
    });
  });
});
