import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionView } from '../src/view/index.js';
import { FileSessionStore } from '../src/storage/index.js';

describe('session view projection', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-view-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loads frontend session view from persisted session objects', async () => {
    const store = new FileSessionStore(root);
    await store.createSession({ id: 'session_1', mode: 'planner_react', title: 'Chat', now: 100 });
    await store.createTask({ id: 'task_1', sessionId: 'session_1', kind: 'react', now: 110 });
    await store.appendMessage({
      id: 'msg_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'user',
      content: 'Hello',
      createdAt: 120,
    });
    await store.createInputRequest({
      id: 'input_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      source: 'agent',
      resumeMode: 'answer_as_user_input',
      prompt: 'Clarify',
      input: { type: 'text' },
      now: 130,
    });
    await store.createContextBuild({
      id: 'ctx_build_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      model: 'qwen-test',
      strategy: 'full',
      maxContextTokens: 100,
      reservedOutputTokens: 20,
      estimatedInputTokens: 40,
      breakdown: { recentMessages: 40 },
      now: 140,
    });
    await store.completeContextBuild('ctx_build_1', {
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, source: 'provider' },
      completedAt: 150,
    });

    const view = await loadSessionView(store, 'session_1');

    expect(view).toMatchObject({
      session: { id: 'session_1' },
      tasks: [{ id: 'task_1' }],
      messages: [{ id: 'msg_1' }],
      inputRequests: [{ id: 'input_1' }],
      tokenStats: {
        latestContextBuildId: 'ctx_build_1',
        totalActualInputTokens: 50,
        totalActualOutputTokens: 10,
      },
    });
  });

  it('loads code projects for code sessions', async () => {
    const store = new FileSessionStore(root);
    await store.createSession({ id: 'session_code', mode: 'code', title: 'Code', now: 100 });
    await store.createCodeProject({
      id: 'project_1',
      sessionId: 'session_code',
      title: 'Demo App',
      sandboxRelativePath: 'code-projects/project_1',
      framework: 'react',
      language: 'typescript',
      now: 110,
    });

    const view = await loadSessionView(store, 'session_code');

    expect(view).toMatchObject({
      session: { id: 'session_code', mode: 'code' },
      codeProjects: [{
        id: 'project_1',
        title: 'Demo App',
        sandboxRelativePath: 'code-projects/project_1',
      }],
    });
  });

  it('hides internal system and planner step messages from frontend session view', async () => {
    const store = new FileSessionStore(root);
    await store.createSession({ id: 'session_1', mode: 'planner_react', title: 'Chat', now: 100 });
    await store.createTask({ id: 'task_1', sessionId: 'session_1', kind: 'planner', now: 110 });

    await store.appendMessage({
      id: 'msg_system_prompt',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'system',
      content: 'React system prompt',
      createdAt: 120,
      metadata: { kind: 'system_prompt', scope: 'task' },
    });
    await store.appendMessage({
      id: 'msg_step_input',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'system',
      content: 'Execute step 1',
      createdAt: 130,
      metadata: { kind: 'planner_step_input', visibility: 'internal' },
    });
    await store.appendMessage({
      id: 'msg_internal_assistant',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'assistant',
      content: 'Internal scratch',
      createdAt: 140,
      metadata: { visibility: 'internal' },
    });
    await store.appendMessage({
      id: 'msg_user',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'user',
      content: 'Hello',
      createdAt: 150,
    });
    await store.appendMessage({
      id: 'msg_assistant',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'assistant',
      content: 'Hi',
      createdAt: 160,
    });

    const view = await loadSessionView(store, 'session_1');

    expect(view.messages.map(message => message.id)).toEqual(['msg_user', 'msg_assistant']);
  });

  it('groups planner step messages and tools under the plan timeline item', async () => {
    const store = new FileSessionStore(root);
    await store.createSession({ id: 'session_plan', mode: 'planner_react', title: 'Plan Chat', now: 100 });
    await store.createTask({ id: 'task_planner', sessionId: 'session_plan', kind: 'planner', executor: 'planner', now: 110 });
    await store.createTask({
      id: 'task_step_1',
      sessionId: 'session_plan',
      parentTaskId: 'task_planner',
      kind: 'planner_step',
      executor: 'react',
      now: 120,
      metadata: { stepId: 'step_1', title: 'Research' },
    });
    await store.createTask({
      id: 'task_step_2',
      sessionId: 'session_plan',
      parentTaskId: 'task_planner',
      kind: 'planner_step',
      executor: 'react',
      now: 130,
      metadata: { stepId: 'step_2', title: 'Write' },
    });
    await store.appendMessage({
      id: 'msg_user',
      sessionId: 'session_plan',
      taskId: 'task_planner',
      role: 'user',
      content: 'Write a report',
      createdAt: 140,
    });
    await store.appendMessage({
      id: 'msg_plan',
      sessionId: 'session_plan',
      taskId: 'task_planner',
      role: 'assistant',
      messageKind: 'plan',
      visibility: 'ui',
      content: '1. Research\n2. Write',
      createdAt: 150,
      metadata: {
        kind: 'plan',
        planId: 'plan_1',
        plan: {
          id: 'plan_1',
          title: 'Report plan',
          steps: [
            { id: 'step_1', title: 'Research', instruction: 'Collect facts' },
            { id: 'step_2', title: 'Write', instruction: 'Draft answer' },
          ],
        },
      },
    });
    await store.appendMessage({
      id: 'msg_plan_update',
      sessionId: 'session_plan',
      taskId: 'task_planner',
      role: 'assistant',
      messageKind: 'plan_update',
      visibility: 'ui',
      content: '1. Research deeply\n2. Write',
      createdAt: 155,
      metadata: {
        kind: 'plan_update',
        planId: 'plan_1',
        plan: {
          id: 'plan_1',
          title: 'Updated report plan',
          steps: [
            { id: 'step_1', title: 'Research deeply', instruction: 'Collect facts' },
            { id: 'step_2', title: 'Write', instruction: 'Draft answer' },
          ],
        },
      },
    });
    await store.appendMessage({
      id: 'msg_step_1_note',
      sessionId: 'session_plan',
      taskId: 'task_step_1',
      role: 'assistant',
      messageKind: 'message',
      visibility: 'ui',
      channel: 'normal',
      content: 'I will search now.',
      createdAt: 160,
      metadata: { stepId: 'step_1' },
    });
    await store.appendMessage({
      id: 'msg_step_1_call',
      sessionId: 'session_plan',
      taskId: 'task_step_1',
      role: 'assistant',
      messageKind: 'tool_call',
      visibility: 'ui',
      channel: 'normal',
      content: '',
      toolCalls: [{ id: 'call_search', name: 'web_search', args: { query: 'report facts' } }],
      createdAt: 170,
      metadata: { stepId: 'step_1' },
    });
    await store.appendMessage({
      id: 'msg_step_1_result',
      sessionId: 'session_plan',
      taskId: 'task_step_1',
      role: 'tool',
      messageKind: 'tool_result',
      visibility: 'ui',
      content: 'Search result',
      toolResult: {
        toolCallId: 'call_search',
        toolName: 'web_search',
        status: 'completed',
        result: { ok: true },
      },
      createdAt: 180,
      metadata: { stepId: 'step_1' },
    });
    await store.appendMessage({
      id: 'msg_step_1_final',
      sessionId: 'session_plan',
      taskId: 'task_step_1',
      role: 'assistant',
      messageKind: 'step_result',
      visibility: 'ui',
      channel: 'final',
      content: 'Stable research facts',
      createdAt: 190,
      metadata: { kind: 'step_result', stepId: 'step_1' },
    });
    await store.appendMessage({
      id: 'msg_planner_final',
      sessionId: 'session_plan',
      taskId: 'task_planner',
      role: 'assistant',
      messageKind: 'planner_final',
      visibility: 'ui',
      channel: 'final',
      content: 'Final report',
      createdAt: 200,
      metadata: { kind: 'planner_final', planId: 'plan_1' },
    });

    const view = await loadSessionView(store, 'session_plan');

    expect(view.messages.map(message => message.id)).toEqual([
      'msg_user',
      'msg_plan',
      'msg_plan_update',
      'msg_step_1_note',
      'msg_step_1_call',
      'msg_step_1_result',
      'msg_step_1_final',
      'msg_planner_final',
    ]);
    expect(view.groupedTimeline).toMatchObject([
      { type: 'message', message: { id: 'msg_user' } },
      {
        type: 'plan',
        message: { id: 'msg_plan' },
        planId: 'plan_1',
        title: 'Updated report plan',
        steps: [
          {
            stepId: 'step_1',
            taskId: 'task_step_1',
            title: 'Research deeply',
            status: 'created',
            items: [
              { type: 'message', message: { id: 'msg_step_1_note' } },
              {
                type: 'tool_call',
                message: { id: 'msg_step_1_call' },
                call: { id: 'call_search', name: 'web_search' },
                resultMessage: { id: 'msg_step_1_result' },
              },
              { type: 'message', message: { id: 'msg_step_1_final' } },
            ],
          },
          {
            stepId: 'step_2',
            taskId: 'task_step_2',
            title: 'Write',
            items: [],
          },
        ],
      },
      { type: 'message', message: { id: 'msg_planner_final' } },
    ]);
  });
});
