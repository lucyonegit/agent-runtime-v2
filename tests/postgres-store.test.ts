import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentContextSnapshotKind } from '../src/domain/index.js';
import { PostgresSessionStore, initializePostgresSessionStoreSchema } from '../src/storage/index.js';

const databaseUrl = process.env.DATABASE_URL
  ?? 'postgresql://postgres:123456@127.0.0.1:5433/postgres';

describe('PostgresSessionStore', () => {
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let schema: string | undefined;
  let store: PostgresSessionStore;

  beforeEach(async () => {
    schema = `agent_runtime_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`create schema "${schema}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    await initializePostgresSessionStoreSchema(pool);
    store = new PostgresSessionStore(pool);
  });

  afterEach(async () => {
    if (pool) {
      await pool.end();
      pool = undefined;
    }
    if (adminPool && schema) {
      await adminPool.query(`drop schema if exists "${schema}" cascade`);
      await adminPool.end();
      adminPool = undefined;
      schema = undefined;
    }
  });

  it('persists sessions, tasks, messages, tool payloads, and input requests', async () => {
    await store.createSession({ id: 'session_1', mode: 'planner_react', title: 'Chat', now: 100 });
    await store.createSession({ id: 'session_2', mode: 'planner_react', now: 101 });
    await store.createTask({
      id: 'task_1',
      sessionId: 'session_1',
      kind: 'react',
      executor: 'react',
      metadata: { source: 'test' },
      now: 110,
    });
    await store.createTask({
      id: 'task_2',
      sessionId: 'session_2',
      kind: 'react',
      now: 111,
    });

    const first = await store.appendMessage({
      id: 'msg_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'choose_cards', args: { count: 3 } }],
      metadata: { stepId: 'step_1' },
      createdAt: 120,
    });
    const second = await store.appendMessage({
      id: 'msg_2',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'tool',
      content: '{"cards":["A","B","C"]}',
      toolResult: {
        toolCallId: 'call_1',
        toolName: 'choose_cards',
        status: 'completed',
        result: { cards: ['A', 'B', 'C'] },
        durationMs: 12,
      },
      createdAt: 130,
    });
    const otherSessionMessage = await store.appendMessage({
      id: 'msg_3',
      sessionId: 'session_2',
      taskId: 'task_2',
      role: 'user',
      content: 'hello',
      createdAt: 140,
    });

    expect(first.rowId).toBeGreaterThan(0);
    expect(second.rowId).toBeGreaterThan(first.rowId);
    expect(otherSessionMessage.rowId).toBeGreaterThan(second.rowId);
    await expect(store.listMessages('session_1')).resolves.toMatchObject([
      {
        id: 'msg_1',
        rowId: first.rowId,
        messageKind: 'tool_call',
        visibility: 'ui',
        toolCalls: [{ id: 'call_1', name: 'choose_cards', args: { count: 3 } }],
        metadata: { stepId: 'step_1' },
      },
      {
        id: 'msg_2',
        rowId: second.rowId,
        messageKind: 'tool_result',
        visibility: 'ui',
        toolResult: {
          toolCallId: 'call_1',
          toolName: 'choose_cards',
          status: 'completed',
          result: { cards: ['A', 'B', 'C'] },
          durationMs: 12,
        },
      },
    ]);
    await expect(store.listMessagesAfterRowId('session_1', first.rowId)).resolves.toMatchObject([
      { id: 'msg_2', rowId: second.rowId },
    ]);

    const request = await store.createInputRequest({
      id: 'input_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      source: 'tool',
      resumeMode: 'answer_as_tool_result',
      toolCallId: 'call_1',
      toolName: 'choose_cards',
      prompt: 'Choose cards',
      input: { type: 'text' },
      now: 150,
    });
    await store.updateTask('task_1', {
      status: 'waiting_user_input',
      waitingRequestId: request.id,
      waitingRequestIds: [request.id],
      updatedAt: 160,
    });
    await store.answerInputRequest('input_1', {
      value: { cards: ['A', 'B', 'C'] },
      messageId: 'msg_2',
      answeredAt: 170,
    });

    await expect(store.getSession('session_1')).resolves.toMatchObject({
      id: 'session_1',
      title: 'Chat',
      mode: 'planner_react',
    });
    await expect(store.listTasks('session_1')).resolves.toMatchObject([
      {
        id: 'task_1',
        status: 'waiting_user_input',
        waitingRequestIds: ['input_1'],
        metadata: { source: 'test' },
      },
    ]);
    await expect(store.listInputRequests('session_1')).resolves.toMatchObject([
      {
        id: 'input_1',
        status: 'answered',
        answer: {
          value: { cards: ['A', 'B', 'C'] },
          messageId: 'msg_2',
        },
      },
    ]);
  });

  it('persists code sessions, code tasks, and code projects', async () => {
    await store.createSession({ id: 'session_code', mode: 'code', title: 'Code Session', now: 100 });
    const project = await store.createCodeProject({
      id: 'project_1',
      sessionId: 'session_code',
      title: 'Demo App',
      status: 'active',
      sandboxRelativePath: 'code-projects/project_1',
      framework: 'react',
      language: 'typescript',
      packageManager: 'pnpm',
      now: 110,
    });
    await store.createTask({
      id: 'task_code',
      sessionId: 'session_code',
      kind: 'code',
      executor: 'code',
      projectId: project.id,
      now: 120,
    });

    expect(project).toMatchObject({
      id: 'project_1',
      sessionId: 'session_code',
      sandboxRelativePath: 'code-projects/project_1',
      packageManager: 'pnpm',
    });
    await expect(store.getCodeProject('project_1')).resolves.toMatchObject({
      id: 'project_1',
      title: 'Demo App',
    });
    await expect(store.listCodeProjects('session_code')).resolves.toMatchObject([
      { id: 'project_1', framework: 'react' },
    ]);
    await expect(store.listTasks('session_code')).resolves.toMatchObject([
      { id: 'task_code', kind: 'code', executor: 'code' },
    ]);
  });

  it('rejects answering a non-pending input request', async () => {
    await store.createSession({ id: 'session_1', mode: 'planner_react', now: 100 });
    await store.createTask({ id: 'task_1', sessionId: 'session_1', kind: 'react', now: 110 });
    await store.createInputRequest({
      id: 'input_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      source: 'agent',
      resumeMode: 'answer_as_user_input',
      prompt: 'Clarify',
      input: { type: 'text' },
      now: 120,
    });
    await store.appendMessage({
      id: 'msg_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      role: 'user',
      content: 'first',
      createdAt: 125,
    });
    await store.answerInputRequest('input_1', {
      value: 'first',
      messageId: 'msg_1',
      answeredAt: 130,
    });

    await expect(store.answerInputRequest('input_1', {
      value: 'second',
      messageId: 'msg_2',
      answeredAt: 140,
    })).rejects.toThrow('Input request is not pending: input_1');
  });

  it('allows only one active root task per session', async () => {
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

  it('persists active context snapshots in postgres', async () => {
    const now = 1000;
    await store.createSession({ id: 'session_pg_ctx', mode: 'planner_react', now });

    await store.replaceActiveContextSnapshot({
      id: 'snap_pg_1',
      sessionId: 'session_pg_ctx',
      kind: AgentContextSnapshotKind.RollingSummary,
      sourceRowIdStart: 1,
      sourceRowIdEnd: 5,
      summary: 'pg summary',
      summaryFormat: 'markdown',
      sourceMessageCount: 5,
      compressionPromptVersion: 'v1',
      now,
    });

    await expect(store.getActiveContextSnapshot('session_pg_ctx')).resolves.toMatchObject({
      id: 'snap_pg_1',
      sourceRowIdEnd: 5,
      summary: 'pg summary',
    });
  });

  it('persists context builds and aggregates provider token stats in postgres', async () => {
    const now = 2000;
    await store.createSession({ id: 'session_pg_usage', mode: 'planner_react', now });
    await store.createTask({
      id: 'task_pg_usage',
      sessionId: 'session_pg_usage',
      kind: 'react',
      now,
    });

    await store.createContextBuild({
      id: 'ctx_build_pg_1',
      sessionId: 'session_pg_usage',
      taskId: 'task_pg_usage',
      taskKind: 'react',
      executor: 'react',
      callPurpose: 'react.loop',
      model: 'qwen-test',
      strategy: 'full',
      maxContextTokens: 100,
      reservedOutputTokens: 20,
      estimatedInputTokens: 40,
      breakdown: { recentMessages: 40, reservedOutput: 20 },
      now,
    });

    await expect(store.completeContextBuild('ctx_build_pg_1', {
      usage: {
        inputTokens: 85,
        outputTokens: 10,
        totalTokens: 95,
        source: 'provider',
      },
      outputId: 'out_pg_1',
      outputChannel: 'final',
      resultType: 'assistant.final',
      toolCallCount: 0,
      toolNames: [],
      completedAt: now + 1,
    })).resolves.toMatchObject({
      taskKind: 'react',
      executor: 'react',
      callPurpose: 'react.loop',
      actualInputTokens: 85,
      actualOutputTokens: 10,
      actualTotalTokens: 95,
      usageSource: 'provider',
      contextUsageRatio: 0.85,
      outputId: 'out_pg_1',
      outputChannel: 'final',
      resultType: 'assistant.final',
      toolCallCount: 0,
      toolNames: [],
    });

    await expect(store.getSessionTokenStats('session_pg_usage')).resolves.toMatchObject({
      totalModelCalls: 1,
      totalActualInputTokens: 85,
      totalActualOutputTokens: 10,
      totalTokens: 95,
      warningLevel: 'critical',
    });
  });

  it('persists canonical plan, step, lease, and scoped context relations', async () => {
    await store.createSession({ id: 'session_runtime', mode: 'planner_react', now: 100 });
    const root = await store.createTask({
      id: 'task_root',
      sessionId: 'session_runtime',
      kind: 'react',
      executor: 'react',
      phase: 'planning',
      routeMode: 'planned',
      executionId: 'execution_1',
      leaseOwner: 'worker_1',
      leaseExpiresAt: 500,
      now: 110,
    });
    const plan = await store.createPlan({
      id: 'plan_1',
      sessionId: 'session_runtime',
      rootTaskId: root.id,
      title: 'Research plan',
      status: 'running',
      now: 120,
    });
    const stepTask = await store.createTask({
      id: 'task_step_1',
      sessionId: 'session_runtime',
      parentTaskId: root.id,
      kind: 'planner_step',
      executor: 'react',
      phase: 'executing',
      now: 130,
    });
    const step = await store.createPlanStep({
      id: 'step_1',
      planId: plan.id,
      taskId: stepTask.id,
      position: 0,
      title: 'Find primary sources',
      instruction: 'Search authoritative sources and return a stable result.',
      status: 'running',
      now: 140,
    });
    const message = await store.appendMessage({
      id: 'msg_step_1',
      sessionId: 'session_runtime',
      taskId: stepTask.id,
      planId: plan.id,
      stepId: step.id,
      outputId: 'output_1',
      role: 'assistant',
      messageKind: 'message',
      content: 'I will start with primary sources.',
      createdAt: 150,
    });
    const request = await store.createInputRequest({
      id: 'input_step_1',
      sessionId: 'session_runtime',
      taskId: stepTask.id,
      planId: plan.id,
      stepId: step.id,
      source: 'tool',
      toolCallId: 'call_1',
      toolCallMessageId: message.id,
      toolName: 'request_user_input',
      resumeMode: 'answer_as_tool_result',
      prompt: 'Confirm the region',
      input: { type: 'text' },
      now: 160,
    });
    await store.answerInputRequest(request.id, {
      value: 'APAC',
      messageId: message.id,
      answeredAt: 170,
    });

    await expect(store.listPlans('session_runtime')).resolves.toMatchObject([
      { id: plan.id, rootTaskId: root.id, status: 'running' },
    ]);
    await expect(store.listPlanSteps(plan.id)).resolves.toMatchObject([
      { id: step.id, taskId: stepTask.id, position: 0, status: 'running' },
    ]);
    await expect(store.listMessages('session_runtime')).resolves.toMatchObject([
      { id: message.id, planId: plan.id, stepId: step.id, outputId: 'output_1' },
    ]);
    await expect(store.listInputRequests('session_runtime')).resolves.toMatchObject([
      {
        id: request.id,
        planId: plan.id,
        stepId: step.id,
        toolCallMessageId: message.id,
        answer: { messageId: message.id },
      },
    ]);
    await expect(store.listTasks('session_runtime')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: root.id,
        phase: 'planning',
        routeMode: 'planned',
        executionId: 'execution_1',
        leaseOwner: 'worker_1',
        leaseExpiresAt: 500,
      }),
    ]));
  });
});
