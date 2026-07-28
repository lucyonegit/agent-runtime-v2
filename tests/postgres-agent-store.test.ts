import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresAgentStore } from '../src/storage/postgres/postgres-agent-store.js';
import { resetAgentRuntimeSchema } from '../src/storage/postgres/schema-management.js';
import { withPostgresReadSnapshot } from '../src/storage/postgres/sql.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
    ?? 'postgresql://postgres:postgres@127.0.0.1:55433/agent_runtime_test',
  max: 4,
});
const store = new PostgresAgentStore(pool);

describe('PostgresAgentStore converged model', () => {
  beforeEach(async () => {
    const client = await pool.connect();
    try { await resetAgentRuntimeSchema(client); } finally { client.release(); }
  });

  afterAll(async () => { await pool.end(); });

  it('keeps all reads in one repeatable-read snapshot', async () => {
    await store.sessions.create({ id: 'session_1', title: 'Test', nowMs: 1 });
    const client = await pool.connect();
    try {
      const versions = await withPostgresReadSnapshot(client, async () => {
        const first = await client.query<{ version: number }>(
          `select version from agent_sessions where id = 'session_1'`
        );
        await pool.query(
          `update agent_sessions set version = version + 1 where id = 'session_1'`
        );
        const second = await client.query<{ version: number }>(
          `select version from agent_sessions where id = 'session_1'`
        );
        return [first.rows[0]!.version, second.rows[0]!.version];
      });
      expect(versions).toEqual([0, 0]);
    } finally {
      client.release();
    }
    await expect(store.sessions.get('session_1')).resolves.toMatchObject({ version: 1 });
  });

  it('loads the complete durable Session projection through one snapshot query', async () => {
    const { task } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await store.plans.apply({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      title: 'Snapshot',
      steps: [{ step: 'Read', status: 'in_progress' }],
      nowMs: 21,
    });

    await expect(store.sessions.loadSnapshot(task.sessionId)).resolves.toMatchObject({
      session: { id: task.sessionId, status: 'active' },
      tasks: [{ id: task.id, status: 'running' }],
      taskRuns: [{ id: started.taskRun.id, status: 'running' }],
      activePlan: { taskId: task.id, title: 'Snapshot' },
      messages: [{ id: 'message_goal', role: 'user' }],
      toolCalls: [],
      toolRuns: [],
      artifacts: [],
      userInputRequests: [],
    });
  });

  it('loads all durable model-input sources through one context snapshot', async () => {
    const { task: firstTask } = await createTask();
    const firstRun = await startRun(firstTask.id, firstTask.version, 'task_run_1', 'initial', 20);
    await store.execution.completeTask({
      sessionId: firstTask.sessionId,
      taskId: firstTask.id,
      taskRunId: firstRun.taskRun.id,
      ownerId: 'worker_1',
      outputId: 'first_output',
      messageId: 'first_final',
      content: 'Old completed answer',
      nowMs: 21,
    });
    const retry = await store.tasks.createRetry({
      sessionId: firstTask.sessionId,
      taskId: 'task_retry',
      retryOfTaskId: firstTask.id,
      clientRequestId: 'context_retry',
      nowMs: 22,
    });
    const started = await startRun(retry.task.id, retry.task.version, 'task_run_2', 'initial', 23);
    await store.plans.apply({
      sessionId: retry.task.sessionId,
      taskId: retry.task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      title: 'Context plan',
      steps: [{ step: 'Inspect', status: 'in_progress' }],
      nowMs: 24,
    });
    const compaction = await store.context.replaceCompaction({
      sessionId: retry.task.sessionId,
      taskId: retry.task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      expectedVersion: null,
      throughMessageRowId: 2,
      summary: 'Earlier work',
      nowMs: 25,
    });
    await expect(store.context.replaceCompaction({
      sessionId: retry.task.sessionId,
      taskId: retry.task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      expectedVersion: null,
      throughMessageRowId: 3,
      summary: 'Stale overwrite',
      nowMs: 26,
    })).rejects.toMatchObject({ code: 'CONCURRENCY_CONFLICT' });
    await expect(store.context.replaceCompaction({
      sessionId: retry.task.sessionId,
      taskId: retry.task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_2',
      expectedVersion: compaction.version,
      throughMessageRowId: 3,
      summary: 'Foreign owner overwrite',
      nowMs: 26,
    })).rejects.toMatchObject({ code: 'TASK_OWNERSHIP_LOST' });

    const snapshot = await store.context.loadInputSnapshot({
      sessionId: retry.task.sessionId,
      taskId: retry.task.id,
      goalMessageId: retry.task.goalMessageId,
    });
    expect(snapshot).toMatchObject({
      activePlan: { taskId: retry.task.id, title: 'Context plan' },
      compaction: { throughMessageRowId: 2, summary: 'Earlier work' },
    });
    expect(snapshot.messages.map(message => message.id)).toEqual(['message_goal']);
  });

  it('advances the Session revision when model usage becomes visible', async () => {
    const { task } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await store.models.startCall({
      id: 'model_call_1',
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      logicalCallKey: 'task.react:1',
      callType: 'task.react',
      provider: 'test',
      model: 'test-model',
      contextRulesVersion: '1',
      inputManifest: {
        purpose: 'task',
        contextRulesVersion: '1',
        systemPromptVersion: '1',
        messageGroupIds: [],
        summaryIds: [],
        fixedPrefixChecksum: 'fixed',
        estimatedBreakdown: {
          system: 1,
          tools: 0,
          summaries: 0,
          messages: 1,
          reservedOutput: 1,
        },
      },
      inputMessages: [],
      inputChecksum: 'input',
      maxContextTokens: 100,
      reservedOutputTokens: 10,
      estimatedInputTokens: 2,
      nowMs: 21,
    });
    const revisionBeforeUsage = (await store.sessions.get(task.sessionId))!.version;

    await store.models.completeCall({
      id: 'model_call_1',
      status: 'completed',
      usageSource: 'provider',
      actualInputTokens: 2,
      actualOutputTokens: 3,
      actualTotalTokens: 5,
      resultType: 'text',
      resultPayload: { content: 'done' },
      nowMs: 22,
    });

    await expect(store.sessions.get(task.sessionId)).resolves.toMatchObject({
      version: revisionBeforeUsage + 1,
    });
    await expect(store.sessions.loadSnapshot(task.sessionId)).resolves.toMatchObject({
      modelUsage: { latestModelCallId: 'model_call_1', totalTokens: 5 },
    });
  });

  it('persists Task, TaskRun, ToolCall and ToolRun while Message owns the result fact', async () => {
    const { task, message: goal } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    const calls = await store.execution.saveToolCalls({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      outputId: 'output_tool_call',
      messageId: 'message_tool_call',
      content: 'I will inspect the workspace.',
      contextScope: 'task',
      toolCalls: [{
        id: 'tool_call_1',
        call: { id: 'model_tool_call_1', name: 'read_file', args: { path: 'code/a.ts' }, type: 'tool_call' },
        argumentsChecksum: 'checksum_1',
        sideEffectLevel: 'read_only',
        idempotencyKey: 'idempotency_1',
      }],
      nowMs: 21,
    });
    expect(calls.toolCalls[0]).toMatchObject({
      id: 'tool_call_1', status: 'pending', createdInTaskRunId: 'task_run_1',
    });

    const revisionBeforeToolStart = (await store.sessions.get(task.sessionId))!.version;
    const toolStarted = await store.execution.startToolRun({
      taskId: task.id,
      taskRunId: 'task_run_1',
      modelToolCallId: 'model_tool_call_1',
      toolRunId: 'tool_run_1',
      workerId: 'worker_1',
      nowMs: 22,
    });
    expect(toolStarted).toMatchObject({
      started: true,
      toolCall: { status: 'running' },
      toolRun: { id: 'tool_run_1', runNo: 1, status: 'running' },
    });
    await expect(store.sessions.get(task.sessionId)).resolves.toMatchObject({
      version: revisionBeforeToolStart + 1,
    });

    const completedTool = await store.execution.completeToolCall({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: 'task_run_1',
      ownerId: 'worker_1',
      modelToolCallId: 'model_tool_call_1',
      messageId: 'message_tool_result',
      outcome: {
        status: 'completed',
        content: '{"content":"export const a = 1"}',
        result: { content: 'export const a = 1' },
        durationMs: 4,
      },
      nowMs: 26,
    });
    expect(completedTool.toolCall).toMatchObject({
      status: 'completed', resultMessageId: 'message_tool_result',
    });
    expect(completedTool.message).toMatchObject({
      id: 'message_tool_result', role: 'tool', messageType: 'tool_result',
      modelToolCallId: 'model_tool_call_1', contextScope: 'task',
    });
    expect(completedTool.toolRun).toMatchObject({ status: 'completed', durationMs: 4 });

    await store.plans.apply({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: 'task_run_1',
      ownerId: 'worker_1',
      title: 'Inspect and answer',
      steps: [{ step: 'Inspect', status: 'completed' }],
      nowMs: 27,
    });
    const finished = await store.execution.completeTask({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: 'task_run_1',
      ownerId: 'worker_1',
      outputId: 'output_final',
      messageId: 'message_final',
      content: 'Done.',
      nowMs: 30,
    });
    expect(finished).toMatchObject({
      task: { status: 'completed' },
      taskRun: { status: 'completed' },
      message: { role: 'assistant', channel: 'final', contextScope: 'conversation' },
      checkpoint: { phase: 'completed', executedToolCalls: 1 },
      toolCalls: [],
      toolRuns: [],
      userInputRequests: [],
      planCleared: true,
    });
    await expect(store.plans.getActive(task.sessionId)).resolves.toBeUndefined();

    const retry = await store.tasks.createRetry({
      sessionId: task.sessionId,
      taskId: 'task_retry',
      retryOfTaskId: task.id,
      clientRequestId: 'retry_1',
      nowMs: 40,
    });
    expect(retry.task).toMatchObject({
      status: 'created', retryOfTaskId: task.id, goalMessageId: goal.id,
    });
    const messages = await store.sessions.listMessages(task.sessionId);
    expect(messages.filter(item => item.role === 'user')).toHaveLength(1);
  });

  it('pauses for one ToolCall and resumes through a new user_input_answered TaskRun', async () => {
    const { task } = await createTask();
    await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await createWaitingToolCall(task.id, 'task_run_1', 21);

    const waiting = await store.execution.waitForUserInput({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: 'task_run_1',
      ownerId: 'worker_1',
      requests: [{
        requestId: 'input_1',
        modelToolCallId: 'model_input_call_1',
        prompt: 'Choose a value',
        inputSchema: { type: 'text' },
      }],
      nowMs: 25,
    });
    expect(waiting).toMatchObject({
      task: { status: 'waiting_for_user' },
      taskRun: { status: 'paused', endedAtMs: 25 },
      toolCalls: [{ status: 'waiting_for_user' }],
      requests: [{ status: 'pending', toolCallId: 'tool_call_input_1' }],
    });

    await expect(store.execution.answerUserInput({
      requestId: 'input_1',
      expectedVersion: 0,
      clientAnswerId: 'invalid_answer',
      answer: 42,
      answerMessageId: 'invalid_answer_message',
      taskRunId: 'invalid_answer_run',
      ownerId: 'worker_1',
      nowMs: 29,
      ownershipExpiresAtMs: 1_000,
    })).rejects.toMatchObject({ code: 'INVALID_USER_INPUT_ANSWER' });
    await expect(store.sessions.listUserInputRequests(task.sessionId)).resolves.toMatchObject([
      { id: 'input_1', status: 'pending', version: 0 },
    ]);
    await expect(store.tasks.getLatestRun(task.id)).resolves.toMatchObject({
      id: 'task_run_1', status: 'paused', runNo: 1,
    });

    const answered = await store.execution.answerUserInput({
      requestId: 'input_1',
      expectedVersion: 0,
      clientAnswerId: 'client_answer_1',
      answer: 'alpha',
      answerMessageId: 'message_input_answer',
      taskRunId: 'task_run_2',
      ownerId: 'worker_1',
      nowMs: 30,
      ownershipExpiresAtMs: 1_000,
    });
    expect(answered).toMatchObject({
      shouldResume: true,
      task: { status: 'running' },
      taskRun: { id: 'task_run_2', runNo: 2, trigger: 'user_input_answered', status: 'running' },
      request: { status: 'answered', answerMessageId: 'message_input_answer' },
      toolCall: { status: 'completed', resultMessageId: 'message_input_answer' },
      answerMessage: {
        role: 'tool', messageType: 'tool_result', modelToolCallId: 'model_input_call_1',
        taskRunId: 'task_run_2',
      },
    });

    await expect(store.execution.answerUserInput({
      requestId: 'input_1',
      expectedVersion: 0,
      clientAnswerId: 'client_answer_1',
      answer: 'alpha',
      answerMessageId: 'unused_replay_message',
      taskRunId: 'unused_replay_run',
      ownerId: 'worker_1',
      nowMs: 31,
      ownershipExpiresAtMs: 1_000,
    })).resolves.toMatchObject({
      shouldResume: false,
      answerMessage: { id: 'message_input_answer', content: 'alpha' },
    });
    await expect(store.execution.answerUserInput({
      requestId: 'input_1',
      expectedVersion: 0,
      clientAnswerId: 'client_answer_1',
      answer: 'beta',
      answerMessageId: 'conflicting_replay_message',
      taskRunId: 'conflicting_replay_run',
      ownerId: 'worker_1',
      nowMs: 32,
      ownershipExpiresAtMs: 1_000,
    })).rejects.toMatchObject({ code: 'USER_INPUT_ANSWER_CONFLICT' });
    await expect(store.tasks.getLatestRun(task.id)).resolves.toMatchObject({
      id: 'task_run_2', runNo: 2,
    });
  });

  it('converts an expired request into a failed ToolMessage and an input_expired TaskRun', async () => {
    const { task } = await createTask();
    await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await createWaitingToolCall(task.id, 'task_run_1', 21);
    await store.execution.waitForUserInput({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: 'task_run_1',
      ownerId: 'worker_1',
      requests: [{
        requestId: 'input_1',
        modelToolCallId: 'model_input_call_1',
        prompt: 'Choose quickly',
        inputSchema: { type: 'text' },
        expiresAtMs: 50,
      }],
      nowMs: 25,
    });

    const expired = await store.execution.expireUserInput({
      requestId: 'input_1',
      expectedVersion: 0,
      resultMessageId: 'message_input_expired',
      taskRunId: 'task_run_2',
      ownerId: 'worker_1',
      nowMs: 51,
      ownershipExpiresAtMs: 1_000,
    });
    expect(expired).toMatchObject({
      shouldResume: true,
      task: { status: 'running' },
      taskRun: { trigger: 'input_expired', status: 'running' },
      request: { status: 'expired' },
      toolCall: { status: 'failed', error: { code: 'user_input_expired' } },
      resultMessage: {
        role: 'tool', modelToolCallId: 'model_input_call_1',
        toolResult: { status: 'failed', code: 'user_input_expired' },
      },
    });
  });

  it('marks abandoned side effects outcome_unknown and never turns them into replayable pending work', async () => {
    const { task } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 10, 20);
    await store.execution.saveToolCalls({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      outputId: 'output_side_effect',
      messageId: 'message_side_effect',
      content: '',
      contextScope: 'task',
      toolCalls: [{
        id: 'tool_call_side_effect',
        call: { id: 'model_side_effect', name: 'run_shell', args: { command: 'deploy' }, type: 'tool_call' },
        argumentsChecksum: 'side_effect_checksum',
        sideEffectLevel: 'side_effecting',
        idempotencyKey: 'side_effect_key',
      }],
      nowMs: 11,
    });
    await store.execution.startToolRun({
      taskId: task.id,
      taskRunId: 'task_run_1',
      modelToolCallId: 'model_side_effect',
      toolRunId: 'tool_run_side_effect',
      workerId: 'worker_1',
      nowMs: 12,
    });

    const recovery = await store.tasks.markRecoveryRequired({
      taskId: task.id,
      expectedTaskVersion: started.task.version,
      nowMs: 21,
    });
    expect(recovery).toMatchObject({
      task: { status: 'recovery_required' },
      taskRun: { status: 'interrupted' },
      toolCalls: [{ status: 'outcome_unknown' }],
      toolRuns: [{ status: 'outcome_unknown' }],
    });
    const resumed = await store.tasks.startRun({
      taskId: task.id,
      expectedTaskVersion: recovery.task.version,
      taskRunId: 'task_run_2',
      trigger: 'manual_resume',
      ownerId: 'worker_1',
      nowMs: 22,
      ownershipExpiresAtMs: 1_000,
    });
    const prepared = await store.execution.prepareToolCallsForResume({
      taskId: task.id,
      taskRunId: resumed.taskRun.id,
      ownerId: 'worker_1',
      nowMs: 23,
    });
    expect(prepared.toolCalls).toEqual([]);
    expect(prepared.blockedToolCalls).toEqual([
      expect.objectContaining({ id: 'tool_call_side_effect', status: 'outcome_unknown' }),
    ]);
  });

  it('requires recovery when a side-effecting tool fails after execution starts', async () => {
    const { task } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await store.execution.saveToolCalls({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      outputId: 'output_side_effect',
      messageId: 'message_side_effect',
      content: '',
      contextScope: 'task',
      toolCalls: [{
        id: 'tool_call_side_effect',
        call: { id: 'model_side_effect', name: 'run_shell', args: { command: 'deploy' }, type: 'tool_call' },
        argumentsChecksum: 'side_effect_checksum',
        sideEffectLevel: 'side_effecting',
        idempotencyKey: 'side_effect_key',
      }],
      nowMs: 21,
    });
    await store.execution.startToolRun({
      taskId: task.id,
      taskRunId: started.taskRun.id,
      modelToolCallId: 'model_side_effect',
      toolRunId: 'tool_run_side_effect',
      workerId: 'worker_1',
      nowMs: 22,
    });

    const input = {
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      modelToolCallId: 'model_side_effect',
      messageId: 'message_side_effect_result',
      outcome: {
        status: 'failed' as const,
        executionStarted: true,
        code: 'shell_exit_nonzero',
        message: 'The command exited with status 1.',
        durationMs: 5,
      },
      nowMs: 27,
    };
    const unknown = await store.execution.completeToolCall(input);

    expect(unknown).toMatchObject({
      toolCall: {
        status: 'outcome_unknown',
        error: { code: 'side_effect_outcome_unknown' },
      },
      toolRun: {
        status: 'outcome_unknown',
        error: { code: 'side_effect_outcome_unknown' },
      },
      message: {
        toolResult: { status: 'failed', code: 'side_effect_outcome_unknown' },
      },
      recoveryRequired: {
        task: { status: 'recovery_required' },
        taskRun: { status: 'interrupted' },
      },
    });
    await expect(store.execution.completeToolCall(input)).resolves.toMatchObject({
      toolCall: { status: 'outcome_unknown' },
      recoveryRequired: { task: { status: 'recovery_required' } },
    });
  });

  it('keeps pre-execution side-effect failures replay-safe', async () => {
    const { task } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await store.execution.saveToolCalls({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      outputId: 'output_side_effect',
      messageId: 'message_side_effect',
      content: '',
      contextScope: 'task',
      toolCalls: [{
        id: 'tool_call_side_effect',
        call: { id: 'model_side_effect', name: 'run_shell', args: { command: '' }, type: 'tool_call' },
        argumentsChecksum: 'side_effect_checksum',
        sideEffectLevel: 'side_effecting',
        idempotencyKey: 'side_effect_key',
      }],
      nowMs: 21,
    });
    await store.execution.startToolRun({
      taskId: task.id,
      taskRunId: started.taskRun.id,
      modelToolCallId: 'model_side_effect',
      toolRunId: 'tool_run_side_effect',
      workerId: 'worker_1',
      nowMs: 22,
    });

    const failed = await store.execution.completeToolCall({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      modelToolCallId: 'model_side_effect',
      messageId: 'message_side_effect_result',
      outcome: {
        status: 'failed',
        executionStarted: false,
        code: 'invalid_tool_arguments',
        message: 'The command is required.',
        durationMs: 0,
      },
      nowMs: 23,
    });

    expect(failed).toMatchObject({
      toolCall: { status: 'failed', error: { code: 'invalid_tool_arguments' } },
      toolRun: { status: 'failed' },
    });
    expect(failed.recoveryRequired).toBeUndefined();
    await expect(store.tasks.get(task.id)).resolves.toMatchObject({ status: 'running' });
  });

  it('keeps an in-flight side effect outcome unknown when the Task is cancelled', async () => {
    const { task } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await store.execution.saveToolCalls({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      outputId: 'output_tools',
      messageId: 'message_tools',
      content: '',
      contextScope: 'task',
      toolCalls: [
        {
          id: 'tool_call_side_effect',
          call: { id: 'model_side_effect', name: 'run_shell', args: { command: 'deploy' }, type: 'tool_call' },
          argumentsChecksum: 'side_effect_checksum',
          sideEffectLevel: 'side_effecting',
          idempotencyKey: 'side_effect_key',
        },
        {
          id: 'tool_call_read',
          call: { id: 'model_read', name: 'read_file', args: { path: 'code/a.ts' }, type: 'tool_call' },
          argumentsChecksum: 'read_checksum',
          sideEffectLevel: 'read_only',
          idempotencyKey: 'read_key',
        },
      ],
      nowMs: 21,
    });
    for (const [modelToolCallId, toolRunId] of [
      ['model_side_effect', 'tool_run_side_effect'],
      ['model_read', 'tool_run_read'],
    ] as const) {
      await store.execution.startToolRun({
        taskId: task.id,
        taskRunId: started.taskRun.id,
        modelToolCallId,
        toolRunId,
        workerId: 'worker_1',
        nowMs: 22,
      });
    }

    const cancelled = await store.tasks.cancel({
      taskId: task.id,
      expectedTaskVersion: started.task.version,
      nowMs: 23,
    });
    const calls = await store.sessions.listToolCalls(task.sessionId);
    const runs = await store.sessions.listToolRuns(task.sessionId);

    expect(calls.find(call => call.id === 'tool_call_side_effect')).toMatchObject({
      status: 'outcome_unknown', error: { code: 'side_effect_outcome_unknown' },
    });
    expect(runs.find(run => run.id === 'tool_run_side_effect')).toMatchObject({
      status: 'outcome_unknown', error: { code: 'side_effect_outcome_unknown' },
    });
    expect(calls.find(call => call.id === 'tool_call_read')).toMatchObject({ status: 'cancelled' });
    expect(runs.find(run => run.id === 'tool_run_read')).toMatchObject({ status: 'cancelled' });
    expect(cancelled).toMatchObject({
      task: { status: 'cancelled' },
      taskRun: { status: 'cancelled' },
      checkpoint: { phase: 'cancelled', executedToolCalls: 2 },
      userInputRequests: [],
      toolCalls: expect.arrayContaining([
        expect.objectContaining({ id: 'tool_call_side_effect', status: 'outcome_unknown' }),
        expect.objectContaining({ id: 'tool_call_read', status: 'cancelled' }),
      ]),
      toolRuns: expect.arrayContaining([
        expect.objectContaining({ id: 'tool_run_side_effect', status: 'outcome_unknown' }),
        expect.objectContaining({ id: 'tool_run_read', status: 'cancelled' }),
      ]),
    });
  });

  it('atomically closes active children and appends a failed checkpoint', async () => {
    const { task } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await store.execution.saveToolCalls({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      outputId: 'output_tools',
      messageId: 'message_tools',
      content: '',
      contextScope: 'task',
      toolCalls: [
        {
          id: 'tool_call_side_effect',
          call: { id: 'model_side_effect', name: 'run_shell', args: { command: 'deploy' }, type: 'tool_call' },
          argumentsChecksum: 'side_effect_checksum',
          sideEffectLevel: 'side_effecting',
          idempotencyKey: 'side_effect_key',
        },
        {
          id: 'tool_call_pending',
          call: { id: 'model_pending', name: 'read_file', args: { path: 'code/a.ts' }, type: 'tool_call' },
          argumentsChecksum: 'pending_checksum',
          sideEffectLevel: 'read_only',
          idempotencyKey: 'pending_key',
        },
      ],
      nowMs: 21,
    });
    await store.execution.startToolRun({
      taskId: task.id,
      taskRunId: started.taskRun.id,
      modelToolCallId: 'model_side_effect',
      toolRunId: 'tool_run_side_effect',
      workerId: 'worker_1',
      nowMs: 22,
    });
    await store.plans.apply({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      title: 'Fail safely',
      steps: [{ step: 'Run', status: 'in_progress' }],
      nowMs: 23,
    });

    const failed = await store.tasks.fail({
      taskId: task.id,
      expectedTaskVersion: started.task.version,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      error: { code: 'runtime_error', message: 'Execution crashed.' },
      nowMs: 24,
    });

    expect(failed).toMatchObject({
      task: { status: 'failed' },
      taskRun: { status: 'failed' },
      checkpoint: {
        phase: 'failed',
        executedToolCalls: 2,
        metadata: { errorCode: 'runtime_error' },
      },
      planCleared: true,
      toolCalls: expect.arrayContaining([
        expect.objectContaining({ id: 'tool_call_side_effect', status: 'outcome_unknown' }),
        expect.objectContaining({ id: 'tool_call_pending', status: 'cancelled' }),
      ]),
      toolRuns: [expect.objectContaining({
        id: 'tool_run_side_effect',
        status: 'outcome_unknown',
      })],
      userInputRequests: [],
    });
    await expect(store.plans.getActive(task.sessionId)).resolves.toBeUndefined();
    await expect(store.execution.getLatestCheckpoint(task.id)).resolves.toMatchObject({
      phase: 'failed',
    });
  });

  it('cancels pending HITL projections and returns their terminal events', async () => {
    const { task } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await createWaitingToolCall(task.id, started.taskRun.id, 21);
    await store.plans.apply({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      title: 'Wait for input',
      steps: [{ step: 'Ask', status: 'in_progress' }],
      nowMs: 23,
    });
    const waiting = await store.execution.waitForUserInput({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      requests: [{
        requestId: 'input_1',
        modelToolCallId: 'model_input_call_1',
        prompt: 'Choose a value',
        inputSchema: { type: 'text' },
      }],
      nowMs: 25,
    });

    const cancelled = await store.tasks.cancel({
      taskId: task.id,
      expectedTaskVersion: waiting.task.version,
      nowMs: 26,
    });

    expect(cancelled).toMatchObject({
      task: { status: 'cancelled' },
      taskRun: { status: 'cancelled' },
      checkpoint: { phase: 'cancelled', executedToolCalls: 1 },
      planCleared: true,
      toolCalls: [expect.objectContaining({
        id: 'tool_call_input_1',
        status: 'cancelled',
      })],
      toolRuns: [],
      userInputRequests: [expect.objectContaining({
        id: 'input_1',
        status: 'cancelled',
      })],
    });
  });

  it('tombstones a Session, fences active execution, and finalizes deletion idempotently', async () => {
    const { task } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await store.execution.saveToolCalls({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      outputId: 'output_delete_side_effect',
      messageId: 'message_delete_side_effect',
      content: '',
      contextScope: 'task',
      toolCalls: [{
        id: 'tool_call_delete_side_effect',
        call: {
          id: 'model_delete_side_effect',
          name: 'run_shell',
          args: { command: 'deploy' },
          type: 'tool_call',
        },
        argumentsChecksum: 'delete_side_effect_checksum',
        sideEffectLevel: 'side_effecting',
        idempotencyKey: 'delete_side_effect_key',
      }],
      nowMs: 21,
    });
    await store.execution.startToolRun({
      taskId: task.id,
      taskRunId: started.taskRun.id,
      modelToolCallId: 'model_delete_side_effect',
      toolRunId: 'tool_run_delete_side_effect',
      workerId: 'worker_1',
      nowMs: 22,
    });

    const fenced = await store.sessions.beginDeletion({
      sessionId: task.sessionId,
      nowMs: 30,
    });

    expect(fenced).toMatchObject({
      existed: true,
      taskFinishes: [{
        task: { id: task.id, status: 'cancelled' },
        taskRun: { id: started.taskRun.id, status: 'cancelled' },
        checkpoint: { phase: 'cancelled', metadata: { reason: 'session_deletion' } },
        toolCalls: [{ id: 'tool_call_delete_side_effect', status: 'outcome_unknown' }],
        toolRuns: [{ id: 'tool_run_delete_side_effect', status: 'outcome_unknown' }],
      }],
    });
    await expect(store.sessions.get(task.sessionId)).resolves.toMatchObject({ status: 'archived' });
    await expect(store.tasks.createWithUserMessage({
      sessionId: task.sessionId,
      taskId: 'task_after_delete',
      userMessageId: 'message_after_delete',
      content: 'Do not start.',
      clientRequestId: 'request_after_delete',
      nowMs: 31,
    })).rejects.toMatchObject({ code: 'INVALID_SESSION_STATE' });

    const repeatedFence = await store.sessions.beginDeletion({
      sessionId: task.sessionId,
      nowMs: 32,
    });
    expect(repeatedFence).toEqual({ existed: true, taskFinishes: [] });
    await expect(store.sessions.finalizeDeletion(task.sessionId)).resolves.toBe(true);
    await expect(store.sessions.finalizeDeletion(task.sessionId)).resolves.toBe(false);
    await expect(store.sessions.beginDeletion({
      sessionId: task.sessionId,
      nowMs: 33,
    })).resolves.toEqual({ existed: false, taskFinishes: [] });
  });

  it('refuses to mark a Task completed while child execution is active', async () => {
    const { task } = await createTask();
    const started = await startRun(task.id, task.version, 'task_run_1', 'initial', 20);
    await createWaitingToolCall(task.id, started.taskRun.id, 21);

    await expect(store.execution.completeTask({
      sessionId: task.sessionId,
      taskId: task.id,
      taskRunId: started.taskRun.id,
      ownerId: 'worker_1',
      outputId: 'output_final',
      messageId: 'message_final',
      content: 'Done too early.',
      nowMs: 23,
    })).rejects.toMatchObject({ code: 'INVALID_TASK_STATE' });
    await expect(store.tasks.get(task.id)).resolves.toMatchObject({ status: 'running' });
  });
});

async function createTask() {
  await store.sessions.create({ id: 'session_1', title: 'Test', nowMs: 1 });
  return store.tasks.createWithUserMessage({
    sessionId: 'session_1',
    taskId: 'task_1',
    userMessageId: 'message_goal',
    content: 'Inspect the code.',
    clientRequestId: 'request_1',
    nowMs: 2,
  });
}

function startRun(
  taskId: string,
  expectedTaskVersion: number,
  taskRunId: string,
  trigger: 'initial' | 'manual_resume',
  nowMs: number,
  ownershipExpiresAtMs = 1_000
) {
  return store.tasks.startRun({
    taskId,
    expectedTaskVersion,
    taskRunId,
    trigger,
    ownerId: 'worker_1',
    nowMs,
    ownershipExpiresAtMs,
  });
}

async function createWaitingToolCall(taskId: string, taskRunId: string, nowMs: number) {
  await store.execution.saveToolCalls({
    sessionId: 'session_1',
    taskId,
    taskRunId,
    ownerId: 'worker_1',
    outputId: 'output_input_call',
    messageId: 'message_input_call',
    content: 'I need one value.',
    contextScope: 'task',
    toolCalls: [{
      id: 'tool_call_input_1',
      call: { id: 'model_input_call_1', name: 'request_user_input', args: {}, type: 'tool_call' },
      argumentsChecksum: 'input_checksum',
      sideEffectLevel: 'read_only',
      idempotencyKey: 'input_key',
    }],
    nowMs,
  });
  await store.execution.startToolRun({
    taskId,
    taskRunId,
    modelToolCallId: 'model_input_call_1',
    toolRunId: 'tool_run_input_1',
    workerId: 'worker_1',
    nowMs: nowMs + 1,
  });
}
