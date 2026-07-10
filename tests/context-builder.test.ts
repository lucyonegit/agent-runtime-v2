import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextBuilder } from '../src/context/index.js';
import {
  AgentContextBuildStrategy,
  AgentContextSnapshotKind,
  type AgentMessage,
} from '../src/domain/index.js';
import { FileSessionStore } from '../src/storage/index.js';

describe('ContextBuilder', () => {
  it('projects regular session messages to LangChain messages', () => {
    const messages: AgentMessage[] = [
      {
        id: 'sys',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 1,
        role: 'system',
        content: 'You are helpful.',
        createdAt: 1,
      },
      {
        id: 'user',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 2,
        role: 'user',
        content: 'Hello',
        createdAt: 2,
      },
      {
        id: 'assistant',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 3,
        role: 'assistant',
        channel: 'final',
        content: 'Hi',
        createdAt: 3,
      },
    ];

    const context = new ContextBuilder().build(messages);

    expect(context[0]).toBeInstanceOf(SystemMessage);
    expect(context[1]).toBeInstanceOf(HumanMessage);
    expect(context[2]).toBeInstanceOf(AIMessage);
  });

  it('projects assistant tool calls only when matching tool results exist', () => {
    const messages: AgentMessage[] = [
      {
        id: 'assistant_tool',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 1,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'choose_card', args: { count: 3 } }],
        createdAt: 1,
      },
      {
        id: 'tool_result',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 2,
        role: 'tool',
        content: '{"cards":["A","B","C"]}',
        toolResult: {
          toolCallId: 'call_1',
          toolName: 'choose_card',
          status: 'completed',
          result: { cards: ['A', 'B', 'C'] },
        },
        createdAt: 2,
      },
    ];

    const context = new ContextBuilder().build(messages);

    expect(context).toHaveLength(2);
    expect(context[0]).toBeInstanceOf(AIMessage);
    expect((context[0] as AIMessage).tool_calls?.[0]).toMatchObject({
      id: 'call_1',
      name: 'choose_card',
      args: { count: 3 },
    });
    expect(context[1]).toBeInstanceOf(ToolMessage);
  });

  it('skips pending tool calls and orphan tool results', () => {
    const messages: AgentMessage[] = [
      {
        id: 'pending_tool',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 1,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'choose_card', args: {} }],
        createdAt: 1,
      },
      {
        id: 'orphan_tool',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 2,
        role: 'tool',
        content: 'orphan',
        toolResult: {
          toolCallId: 'call_missing',
          toolName: 'missing',
          status: 'completed',
          result: 'orphan',
        },
        createdAt: 2,
      },
      {
        id: 'user',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 3,
        role: 'user',
        content: 'continue',
        createdAt: 3,
      },
    ];

    const context = new ContextBuilder().build(messages);

    expect(context).toHaveLength(1);
    expect(context[0]).toBeInstanceOf(HumanMessage);
  });

  it('builds context from active snapshot plus tail messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-context-'));
    try {
      const store = new FileSessionStore(root);
      const now = Date.now();
      await store.createSession({ id: 'session_build_ctx', mode: 'planner_react', now });
      const task = await store.createTask({
        id: 'task_build_ctx',
        sessionId: 'session_build_ctx',
        kind: 'react',
        executor: 'react',
        now,
      });

      await store.appendMessage({
        id: 'msg_old',
        sessionId: 'session_build_ctx',
        taskId: task.id,
        role: 'user',
        content: 'old message',
        createdAt: now,
      });

      await store.replaceActiveContextSnapshot({
        id: 'snap_build',
        sessionId: 'session_build_ctx',
        kind: AgentContextSnapshotKind.RollingSummary,
        sourceRowIdStart: 1,
        sourceRowIdEnd: 1,
        summary: '## Conversation Summary\nold message summarized',
        summaryFormat: 'markdown',
        sourceMessageCount: 1,
        compressionPromptVersion: 'v1',
        now,
      });

      await store.appendMessage({
        id: 'msg_tail',
        sessionId: 'session_build_ctx',
        taskId: task.id,
        role: 'user',
        content: 'new tail message',
        createdAt: now + 1,
      });

      const built = await new ContextBuilder().buildForModel({
        store,
        sessionId: 'session_build_ctx',
        taskId: task.id,
        model: 'test-model',
        systemPrompt: 'You are helpful.',
      });

      expect(built.strategy).toBe(AgentContextBuildStrategy.SnapshotTail);
      const content = built.messages.map(message => String(message.content)).join('\n');
      expect(content).toContain('old message summarized');
      expect(content).toContain('new tail message');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sanitizes legacy raw transcript snapshots before injecting them into model context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-context-'));
    try {
      const store = new FileSessionStore(root);
      const now = Date.now();
      await store.createSession({ id: 'session_legacy_snapshot', mode: 'planner_react', now });
      const task = await store.createTask({
        id: 'task_legacy_snapshot',
        sessionId: 'session_legacy_snapshot',
        kind: 'react',
        executor: 'react',
        now,
      });
      await store.appendMessage({
        id: 'msg_old',
        sessionId: 'session_legacy_snapshot',
        taskId: task.id,
        role: 'user',
        content: 'old covered message',
        createdAt: now,
      });

      await store.replaceActiveContextSnapshot({
        id: 'snap_legacy',
        sessionId: 'session_legacy_snapshot',
        kind: AgentContextSnapshotKind.RollingSummary,
        sourceRowIdStart: 1,
        sourceRowIdEnd: 1,
        summary: [
          '## Conversation Summary',
          'No previous summary.',
          '',
          '## Recent Compressed Messages',
          'system: # Role',
          '你是一个真实运行的 ReAct 执行型 Agent。',
          'assistant: hello tool_calls=[{"name":"web_search"}]',
          'tool: {"huge":"payload"} tool_result={"result":true}',
          '',
          '## Open Questions',
          'None recorded.',
        ].join('\n'),
        summaryFormat: 'markdown',
        sourceMessageCount: 1,
        compressionPromptVersion: 'basic-v1',
        now,
      });

      await store.appendMessage({
        id: 'msg_tail',
        sessionId: 'session_legacy_snapshot',
        taskId: task.id,
        role: 'user',
        content: '继续',
        createdAt: now + 1,
      });

      const built = await new ContextBuilder().buildForModel({
        store,
        sessionId: 'session_legacy_snapshot',
        taskId: task.id,
        systemPrompt: 'You are helpful.',
      });

      const content = built.messages.map(message => String(message.content)).join('\n');
      expect(content).toContain('Legacy raw transcript omitted');
      expect(content).toContain('继续');
      expect(content).not.toContain('你是一个真实运行的 ReAct');
      expect(content).not.toContain('tool_calls=');
      expect(content).not.toContain('tool_result=');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates a rolling snapshot when context exceeds the token budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-context-'));
    try {
      const store = new FileSessionStore(root);
      const now = Date.now();
      await store.createSession({ id: 'session_compress_ctx', mode: 'planner_react', now });
      const task = await store.createTask({
        id: 'task_compress_ctx',
        sessionId: 'session_compress_ctx',
        kind: 'react',
        executor: 'react',
        now,
      });

      await store.appendMessage({
        id: 'msg_old',
        sessionId: 'session_compress_ctx',
        taskId: task.id,
        role: 'user',
        content: 'old message '.repeat(80),
        createdAt: now,
      });
      await store.appendMessage({
        id: 'msg_tail',
        sessionId: 'session_compress_ctx',
        taskId: task.id,
        role: 'user',
        content: 'recent tail',
        createdAt: now + 1,
      });

      const built = await new ContextBuilder().buildForModel({
        store,
        sessionId: 'session_compress_ctx',
        taskId: task.id,
        model: 'test-model',
        budget: {
          maxContextTokens: 60,
          reservedOutputTokens: 10,
          compressionTriggerRatio: 0.5,
          minTailMessages: 1,
          minTailTokens: 1,
          maxSnapshotTokens: 20,
        },
      });

      expect(built.strategy).toBe(AgentContextBuildStrategy.CompressedThenSnapshotTail);
      await expect(store.getActiveContextSnapshot('session_compress_ctx')).resolves.toMatchObject({
        sourceRowIdEnd: 1,
      });
      expect(built.messages.map(message => String(message.content)).join('\n')).toContain('recent tail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
