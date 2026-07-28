import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresAgentStore } from '../src/storage/postgres/postgres-agent-store.js';
import { resetAgentRuntimeSchema } from '../src/storage/postgres/schema-management.js';

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
