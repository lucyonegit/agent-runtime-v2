import { Pool, type PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AIMessageChunk,
  type BaseMessage,
  coerceMessageLikeToMessage,
} from '@langchain/core/messages';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { Runnable, type RunnableConfig } from '@langchain/core/runnables';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { JobExecutionSupervisorPort } from '../src/orchestration/job-execution-supervisor.js';
import { JobManager } from '../src/orchestration/job-manager.js';
import { AuditedChatModel } from '../src/runtime/model/audited-chat-model.js';
import { executeDurableAgentLoop } from '../src/runtime/execution/helpers/durable-loop-execution.helper.js';
import { ToolExecutor } from '../src/runtime/execution/tool-executor.js';
import type { JobExecutionStatePort } from '../src/runtime/execution/types/react-execution.types.js';
import { AgentLoop } from '../src/runtime/loop/agent-loop.js';
import { RuntimeEventWriter } from '../src/runtime/events/runtime-event-writer.js';
import { ContextFormatter } from '../src/runtime/context/helpers/context-formatter.helper.js';
import { MessageGroupBuilder } from '../src/runtime/context/helpers/message-group.helper.js';
import type { AgentRealtimeEvent } from '../src/domain/index.js';
import {
  checksumToolArguments,
} from '../src/runtime/execution/helpers/tool-call-identity.helper.js';
import { SessionView } from '../src/view/session-view.js';
import { PostgresAgentStore } from '../src/storage/postgres/postgres-agent-store.js';
import { applyAgentRuntimeSchemaV1 } from '../src/storage/postgres/schema-v1.js';
import { applyAgentRuntimeSchemaV2 } from '../src/storage/postgres/schema-v2.js';
import { applyAgentRuntimeSchemaV3 } from '../src/storage/postgres/schema-v3.js';
import { applyAgentRuntimeSchemaV4 } from '../src/storage/postgres/schema-v4.js';
import { applyAgentRuntimeSchemaV5 } from '../src/storage/postgres/schema-v5.js';
import type {
  RuntimeTool,
  RuntimeToolContext,
  RuntimeUserInputArtifact,
} from '../src/runtime/execution/tool-executor.js';

const databaseUrl = process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:55433/agent_runtime_test';

describe('PostgresAgentStore Job transactions', () => {
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let store: PostgresAgentStore;
  let schema: string | undefined;
  let schemaCreated = false;

  beforeEach(async () => {
    schema = `agent_store_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`create schema "${schema}"`);
    schemaCreated = true;
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const client = await pool.connect();
    try {
      await applyAgentRuntimeSchemaV1(client, 1_000);
      await applyAgentRuntimeSchemaV2(client, 1_001);
      await applyAgentRuntimeSchemaV3(client, 1_002);
      await applyAgentRuntimeSchemaV4(client, 1_003);
      await applyAgentRuntimeSchemaV5(client, 1_004);
    } finally {
      client.release();
    }
    store = new PostgresAgentStore(pool);
  });

  afterEach(async () => {
    if (pool) await pool.end();
    pool = undefined;
    if (adminPool && schema && schemaCreated) {
      await adminPool.query(`drop schema if exists "${schema}" cascade`);
    }
    if (adminPool) await adminPool.end();
    adminPool = undefined;
    schema = undefined;
    schemaCreated = false;
  });

  it('atomically creates a Job, user message, and Session version update', async () => {
    await store.createSession({ id: 'session_create', nowMs: 10 });

    const result = await createJob(store, 'session_create', 'job_create', 'message_create', 20);

    expect(result.session).toMatchObject({ version: 1, updatedAtMs: 20 });
    expect(result.job).toMatchObject({
      id: 'job_create',
      sessionId: 'session_create',
      status: 'created',
      version: 0,
    });
    expect(result.message).toMatchObject({
      id: 'message_create',
      rowId: 1,
      role: 'user',
      messageType: 'user_message',
      content: 'hello job_create',
    });
  });

  it('rolls back every write when a Session already has an active Job', async () => {
    await store.createSession({ id: 'session_conflict', nowMs: 10 });
    await createJob(store, 'session_conflict', 'job_first', 'message_first', 20);

    await expect(
      createJob(store, 'session_conflict', 'job_second', 'message_second', 30)
    ).rejects.toMatchObject({ code: 'ACTIVE_JOB_CONFLICT' });

    expect(await store.getJob('job_second')).toBeUndefined();
    expect(await store.listSessionMessages('session_conflict')).toHaveLength(1);
    expect(await store.getSession('session_conflict')).toMatchObject({ version: 1, updatedAtMs: 20 });
  });

  it('replays an identical clientRequestId and rejects payload drift', async () => {
    await store.createSession({ id: 'session_idempotent', nowMs: 10 });
    const jobIds = ['job_idempotent', 'job_unused', 'job_changed'];
    const messageIds = ['message_idempotent', 'message_unused', 'message_changed'];
    const manager = new JobManager({
      store,
      publisher: { publish: () => undefined },
      execution: noOpExecutionSupervisor(),
      workerId: 'worker_idempotent',
      clock: { nowMs: () => 20 },
      ids: {
        jobId: () => jobIds.shift()!,
        messageId: () => messageIds.shift()!,
        attemptId: () => 'attempt_idempotent',
      },
    });
    const first = await manager.createJob({
      sessionId: 'session_idempotent',
      clientRequestId: 'request_idempotent',
      message: 'same payload',
    });
    const replay = await manager.createJob({
      sessionId: 'session_idempotent',
      clientRequestId: 'request_idempotent',
      message: 'same payload',
    });
    expect(replay).toEqual(first);
    expect(await store.listSessionMessages('session_idempotent')).toHaveLength(1);

    await expect(manager.createJob({
      sessionId: 'session_idempotent',
      clientRequestId: 'request_idempotent',
      message: 'changed payload',
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('allows exactly one concurrent attempt start and rejects stale or foreign renewals', async () => {
    await store.createSession({ id: 'session_claim', nowMs: 10 });
    await createJob(store, 'session_claim', 'job_claim', 'message_claim', 20);

    const attemptStarts = await Promise.allSettled([
      store.startJobExecution({
        jobId: 'job_claim',
        expectedVersion: 0,
        workerId: 'worker_a',
        attemptId: 'attempt_a',
        nowMs: 30,
        leaseUntilMs: 100,
      }),
      store.startJobExecution({
        jobId: 'job_claim',
        expectedVersion: 0,
        workerId: 'worker_b',
        attemptId: 'attempt_b',
        nowMs: 30,
        leaseUntilMs: 100,
      }),
    ]);
    const fulfilled = attemptStarts.filter(result => result.status === 'fulfilled');
    const rejected = attemptStarts.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CONCURRENCY_CONFLICT',
    });

    const startedJob = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.startJobExecution>>>).value;
    await expect(store.renewJobExecutionLease({
      jobId: startedJob.id,
      expectedVersion: startedJob.version,
      workerId: startedJob.leaseOwner!,
      attemptId: 'foreign_attempt',
      nowMs: 40,
      leaseUntilMs: 120,
    })).rejects.toMatchObject({ code: 'JOB_LEASE_LOST' });

    const renewed = await store.renewJobExecutionLease({
      jobId: startedJob.id,
      expectedVersion: startedJob.version,
      workerId: startedJob.leaseOwner!,
      attemptId: startedJob.currentAttemptId!,
      nowMs: 40,
      leaseUntilMs: 120,
    });
    expect(renewed).toMatchObject({
      version: 1,
      leaseExpiresAtMs: 120,
      attemptNo: 1,
      updatedAtMs: startedJob.updatedAtMs,
    });

    const paused = await store.markJobRecoveryRequired({
      jobId: renewed.id, expectedVersion: renewed.version, nowMs: 121,
    });
    expect(paused).toMatchObject({
      status: 'recovery_required', version: 2,
    });
    expect(paused).not.toHaveProperty('currentAttemptId');
    expect(paused).not.toHaveProperty('leaseOwner');
    expect(paused).not.toHaveProperty('leaseExpiresAtMs');

    const recovered = await store.startJobExecution({
      jobId: paused.id,
      expectedVersion: paused.version,
      workerId: 'worker_recovery',
      attemptId: 'attempt_recovery',
      nowMs: 121,
      leaseUntilMs: 200,
    });
    expect(recovered).toMatchObject({
      version: 3,
      attemptNo: 2,
      leaseOwner: 'worker_recovery',
      currentAttemptId: 'attempt_recovery',
    });
  });

  it('commits tool calls before execution and atomically commits each tool result', async () => {
    await store.createSession({ id: 'session_tools', nowMs: 10 });
    await createJob(store, 'session_tools', 'job_tools', 'message_tools', 20);
    const job = await store.startJobExecution({
      jobId: 'job_tools',
      expectedVersion: 0,
      workerId: 'worker_tools',
      attemptId: 'attempt_tools',
      nowMs: 30,
      leaseUntilMs: 100,
    });
    const committed = await store.commitModelToolCalls({
      sessionId: 'session_tools',
      jobId: job.id,
      attemptId: job.currentAttemptId!,
      workerId: job.leaseOwner!,
      outputId: 'output_tools',
      messageId: 'message_tool_calls',
      content: '',
      invocations: [
        pendingInvocation('invocation_lookup', 'call_lookup', 'lookup'),
        pendingInvocation('invocation_missing', 'call_missing', 'missing'),
      ],
      nowMs: 31,
    });
    expect(committed.message).toMatchObject({
      messageType: 'tool_call',
      toolCalls: [{ id: 'call_lookup' }, { id: 'call_missing' }],
    });
    expect(committed.invocations.map(invocation => invocation.status)).toEqual(['pending', 'pending']);

    const executor = new ToolExecutor({
      store,
      workerId: 'worker_tools',
      clock: { nowMs: () => 32 },
      tools: [completedRuntimeTool('lookup', async arguments_ => ({
        content: `found:${arguments_.query}`,
        result: { found: true },
      }))],
    });
    const lookupResult = await executor.execute({
      call: { id: 'call_lookup', name: 'lookup', args: { query: 'docs' } },
      target: {
        sessionId: 'session_tools',
        jobId: 'job_tools',
        attemptId: 'attempt_tools',
      },
    });
    expect(lookupResult).toMatchObject({ type: 'completed', content: 'found:docs' });
    if (lookupResult.type !== 'completed') throw new Error('expected completed tool result');
    expect(await store.getToolInvocation('job_tools', 'call_lookup')).toMatchObject({
      status: 'running',
      version: 1,
    });

    const lookupCommit = await store.commitToolResult({
      sessionId: 'session_tools',
      jobId: 'job_tools',
      attemptId: 'attempt_tools',
      workerId: 'worker_tools',
      toolCallId: 'call_lookup',
      messageId: 'message_lookup_result',
      outcome: {
        status: 'completed',
        content: lookupResult.content,
        result: lookupResult.result,
        durationMs: 5,
      },
      nowMs: 37,
    });
    expect(lookupCommit.invocation).toMatchObject({
      status: 'completed',
      resultMessageId: 'message_lookup_result',
      resultPayload: { found: true },
    });
    expect(lookupCommit.message).toMatchObject({
      messageType: 'tool_result',
      toolResult: { status: 'completed', result: { found: true }, durationMs: 5 },
    });

    const missingResult = await executor.execute({
      call: { id: 'call_missing', name: 'missing', args: {} },
      target: {
        sessionId: 'session_tools',
        jobId: 'job_tools',
        attemptId: 'attempt_tools',
      },
    });
    expect(missingResult).toMatchObject({ type: 'failed', code: 'tool_not_found' });
    if (missingResult.type !== 'failed') throw new Error('expected failed tool result');
    await expect(store.commitToolResult({
      sessionId: 'session_tools',
      jobId: 'job_tools',
      attemptId: 'attempt_tools',
      workerId: 'worker_tools',
      toolCallId: 'call_missing',
      messageId: 'message_missing_result',
      outcome: { status: 'failed', ...missingResult, durationMs: 1 },
      nowMs: 38,
    })).resolves.toMatchObject({ invocation: { status: 'failed' } });
  });

  it('rejects ToolInvocation execution acquisition after the Job lease is lost', async () => {
    await store.createSession({ id: 'session_tool_fence', nowMs: 10 });
    await createJob(store, 'session_tool_fence', 'job_tool_fence', 'message_tool_fence', 20);
    const job = await store.startJobExecution({
      jobId: 'job_tool_fence',
      expectedVersion: 0,
      workerId: 'worker_owner',
      attemptId: 'attempt_owner',
      nowMs: 30,
      leaseUntilMs: 40,
    });
    await store.commitModelToolCalls({
      sessionId: 'session_tool_fence',
      jobId: job.id,
      attemptId: job.currentAttemptId!,
      workerId: job.leaseOwner!,
      outputId: 'output_fence',
      messageId: 'message_fence_calls',
      content: '',
      invocations: [pendingInvocation('invocation_fence', 'call_fence', 'lookup')],
      nowMs: 31,
    });
    const executor = new ToolExecutor({
      store,
      workerId: 'worker_owner',
      clock: { nowMs: () => 41 },
      tools: [],
    });

    await expect(executor.execute({
      call: { id: 'call_fence', name: 'lookup', args: {} },
      target: {
        sessionId: 'session_tool_fence',
        jobId: 'job_tool_fence',
        attemptId: 'attempt_owner',
      },
    })).rejects.toMatchObject({ code: 'lease_lost' });
    expect(await store.getToolInvocation('job_tool_fence', 'call_fence')).toMatchObject({
      status: 'pending',
      version: 0,
    });
  });

  it('answers multiple tool inputs atomically and gives resume ownership to exactly one answer', async () => {
    await store.createSession({ id: 'session_inputs', nowMs: 10 });
    await createJob(store, 'session_inputs', 'job_inputs', 'message_inputs', 20);
    const job = await store.startJobExecution({
      jobId: 'job_inputs',
      expectedVersion: 0,
      workerId: 'worker_inputs',
      attemptId: 'attempt_inputs',
      nowMs: 30,
      leaseUntilMs: 100,
    });
    await store.commitModelToolCalls({
      sessionId: 'session_inputs',
      jobId: job.id,
      attemptId: 'attempt_inputs',
      workerId: 'worker_inputs',
      outputId: 'output_inputs',
      messageId: 'message_input_calls',
      content: '',
      invocations: [
        pendingInvocation('invocation_input_a', 'call_input_a', 'choose_a'),
        pendingInvocation('invocation_input_b', 'call_input_b', 'choose_b'),
      ],
      nowMs: 31,
    });
    await store.tryStartToolExecution({
      jobId: 'job_inputs',
      toolCallId: 'call_input_a',
      workerId: 'worker_inputs',
      attemptId: 'attempt_inputs',
      nowMs: 32,
    });
    await store.tryStartToolExecution({
      jobId: 'job_inputs',
      toolCallId: 'call_input_b',
      workerId: 'worker_inputs',
      attemptId: 'attempt_inputs',
      nowMs: 32,
    });

    const waiting = await store.createInputRequestsAndMarkWaiting({
      sessionId: 'session_inputs',
      jobId: 'job_inputs',
      attemptId: 'attempt_inputs',
      workerId: 'worker_inputs',
      requests: [
        {
          requestId: 'input_a',
          toolCallId: 'call_input_a',
          source: 'tool',
          answerMode: 'as_tool_result',
          prompt: 'Choose A',
          inputSchema: { type: 'text' },
        },
        {
          requestId: 'input_b',
          toolCallId: 'call_input_b',
          source: 'tool',
          answerMode: 'as_tool_result',
          prompt: 'Choose B',
          inputSchema: { type: 'text' },
        },
      ],
      nowMs: 33,
    });
    expect(waiting.job).toMatchObject({ status: 'waiting_user_input', version: 2 });
    expect(waiting.job).not.toHaveProperty('leaseOwner');
    expect(waiting.requests).toHaveLength(2);
    expect(waiting.invocations.map(invocation => invocation.status))
      .toEqual(['waiting_user_input', 'waiting_user_input']);

    const answers = await Promise.all([
      store.saveUserInputAnswerAndResumeIfReady({
        requestId: 'input_a',
        expectedVersion: 0,
        clientAnswerId: 'answer_a',
        answer: 'A',
        answerMessageId: 'message_answer_a',
        workerId: 'worker_resume_a',
        attemptId: 'attempt_resume_a',
        nowMs: 40,
        leaseUntilMs: 100,
      }),
      store.saveUserInputAnswerAndResumeIfReady({
        requestId: 'input_b',
        expectedVersion: 0,
        clientAnswerId: 'answer_b',
        answer: 'B',
        answerMessageId: 'message_answer_b',
        workerId: 'worker_resume_b',
        attemptId: 'attempt_resume_b',
        nowMs: 40,
        leaseUntilMs: 100,
      }),
    ]);
    expect(answers.filter(answer => answer.shouldResume)).toHaveLength(1);
    expect(answers.filter(answer => !answer.shouldResume)).toHaveLength(1);
    const resumeWinner = answers.find(answer => answer.shouldResume)!;
    expect(resumeWinner.job).toMatchObject({
      status: 'resuming',
      version: 3,
      currentAttemptId: resumeWinner.attemptId,
      attemptNo: 2,
    });
    expect(answers.map(answer => answer.request.status)).toEqual(['answered', 'answered']);
    expect(answers.map(answer => answer.answerMessage.messageType)).toEqual(['tool_result', 'tool_result']);
    expect(answers.map(answer => answer.invocation?.status)).toEqual(['completed', 'completed']);

    await expect(store.saveUserInputAnswerAndResumeIfReady({
      requestId: 'input_a',
      expectedVersion: 0,
      clientAnswerId: 'answer_a',
      answer: 'A',
      answerMessageId: 'unused_message',
      workerId: 'unused_worker',
      attemptId: 'unused_attempt',
      nowMs: 50,
      leaseUntilMs: 110,
    })).resolves.toMatchObject({
      request: { status: 'answered', clientAnswerId: 'answer_a' },
      shouldResume: false,
    });
    await expect(store.saveUserInputAnswerAndResumeIfReady({
      requestId: 'input_a',
      expectedVersion: 1,
      clientAnswerId: 'different_answer',
      answer: 'different',
      answerMessageId: 'different_message',
      workerId: 'unused_worker',
      attemptId: 'unused_attempt',
      nowMs: 51,
      leaseUntilMs: 111,
    })).rejects.toMatchObject({ code: 'USER_INPUT_ANSWER_CONFLICT' });
  });

  it('runs a direct Job from model tool call through durable result to atomic final completion', async () => {
    await store.createSession({ id: 'session_direct', nowMs: 10 });
    await createJob(store, 'session_direct', 'job_direct', 'message_direct', 20);
    const startedJob = await store.startJobExecution({
      jobId: 'job_direct',
      expectedVersion: 0,
      workerId: 'worker_direct',
      attemptId: 'attempt_direct',
      nowMs: 30,
      leaseUntilMs: 100,
    });
    let durableBeforeExternalExecution = false;
    const runtimeLookup = completedRuntimeTool('lookup', async (_arguments, context) => {
      durableBeforeExternalExecution = (
        await store.getToolInvocation(context.jobId, context.toolCallId)
      )?.status === 'running';
      return {
        content: 'lookup result',
        result: {
          value: 42,
          artifacts: [{
            kind: 'file', area: 'docs', title: 'Lookup result', fileName: 'lookup.md',
            logicalPath: 'docs/lookup.md',
            storagePath: '.revisions/runtime_invocation_1/docs/lookup.md',
            mediaType: 'text/markdown', size: 42, checksum: 'checksum_lookup',
          }],
        },
      };
    });
    const definition = runtimeLookup.tool;
    const toolExecutor = new ToolExecutor({
      store,
      workerId: 'worker_direct',
      tools: [runtimeLookup],
      clock: { nowMs: () => 35 },
    });
    let modelCalls = 0;
    let outputNo = 1;
    const loop = new AgentLoop({
      streaming: false,
      model: new TestChatRunnable(async input => {
          modelCalls += 1;
          if (modelCalls === 1) {
            expect(inputMessages(input)).toHaveLength(0);
            return new AIMessageChunk({
              content: '',
              tool_calls: [{ id: 'call_direct', name: 'lookup', args: { query: 'runtime' } }],
            });
          }
          expect(inputMessages(input)).toHaveLength(2);
          return new AIMessageChunk('final direct answer');
        }),
      createOutputId: () => `runtime_output_${outputNo++}`,
      clock: { nowMs: () => 35 },
    });
    const published: AgentRealtimeEvent[] = [];
    let messageNo = 1;
    let invocationNo = 1;
    const writer = new RuntimeEventWriter({
      store,
      workerId: 'worker_direct',
      tools: [runtimeLookup],
      publisher: { publish: event => { published.push(event); } },
      ids: {
        eventId: () => 'event_direct',
        messageId: () => `runtime_message_${messageNo++}`,
        toolInvocationId: () => `runtime_invocation_${invocationNo++}`,
        artifactId: () => 'artifact_direct_1',
        userInputRequestId: () => 'runtime_input_1',
      },
      clock: { nowMs: () => 36 },
    });
    const result = await executeDurableAgentLoop({
      loop,
      writer,
      jobState: jobExecutionState(store, 'worker_direct', 36),
      input: {
        job: startedJob,
        loopInput: {
          context: {
            loadMessages: () => loadPersistedToolMessages(store, startedJob.sessionId),
          },
          tools: {
            definitions: [definition],
            executor: toolExecutor,
          },
          limits: { maxIterations: 4, maxToolCalls: 4, deadlineMs: 90 },
        },
      },
    });

    expect(durableBeforeExternalExecution).toBe(true);
    expect(result).toMatchObject({
      type: 'completed',
      job: {
        id: 'job_direct',
        status: 'completed',
        version: 2,
      },
      message: {
        messageType: 'assistant_message',
        channel: 'final',
        content: 'final direct answer',
      },
    });
    expect((await store.listSessionMessages('session_direct')).map(message => ({
      rowId: message.rowId,
      type: message.messageType,
    }))).toEqual([
      { rowId: 1, type: 'user_message' },
      { rowId: 2, type: 'tool_call' },
      { rowId: 3, type: 'tool_result' },
      { rowId: 4, type: 'assistant_message' },
    ]);
    expect(published.map(event => event.type)).toEqual([
      'message.upserted',
      'tool_invocation.upserted',
      'message.upserted',
      'tool_invocation.upserted',
      'artifact.upserted',
      'message.upserted',
      'job.upserted',
    ]);
    const directView = await new SessionView(
      store,
      { nowMs: () => 50 },
      {
        async listSessionProcesses(sessionId) {
          return [{
            id: 'process_live',
            sessionId,
            jobId: 'job_direct',
            toolInvocationId: 'runtime_invocation_1',
            name: 'preview',
            command: 'npm run dev',
            cwd: 'code/app',
            status: 'running' as const,
            pid: 1234,
            processGroupId: 1234,
            host: '127.0.0.1',
            port: 4100,
            url: 'http://127.0.0.1:4100',
            logPath: '.runtime/processes/process_live/process.log',
            version: 0,
            createdAtMs: 45,
            startedAtMs: 46,
            updatedAtMs: 47,
          }];
        },
      }
    ).load('session_direct');
    expect(directView.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact_direct_1', logicalPath: 'docs/lookup.md', revision: 1,
        toolInvocationId: 'runtime_invocation_1',
      }),
    ]);
    expect(directView).toMatchObject({
      schemaVersion: 4,
      generatedAtMs: 50,
      managedProcesses: [{ id: 'process_live', status: 'running', port: 4100 }],
      cursor: { latestMessageRowId: 4 },
      timeline: {
        flat: [
          { type: 'message' },
          { type: 'tool_exchange', status: 'completed', artifacts: [{ id: 'artifact_direct_1' }] },
          { type: 'message' },
        ],
      },
    });
  });

  it('records malformed model tool arguments as a pre-execution failure and continues', async () => {
    await store.createSession({ id: 'session_invalid_tool_args', nowMs: 10 });
    await createJob(
      store,
      'session_invalid_tool_args',
      'job_invalid_tool_args',
      'message_invalid_tool_args',
      20
    );
    const startedJob = await store.startJobExecution({
      jobId: 'job_invalid_tool_args',
      expectedVersion: 0,
      workerId: 'worker_invalid_tool_args',
      attemptId: 'attempt_invalid_tool_args',
      nowMs: 30,
      leaseUntilMs: 100,
    });
    const runtimeLookup = completedRuntimeTool('lookup', async () => {
      throw new Error('Malformed tool arguments must not execute the tool.');
    });
    let modelCalls = 0;
    const delegate = new TestChatRunnable(async input => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return new AIMessageChunk({
          content: '',
          tool_call_chunks: [{
            index: 0,
            id: 'call_invalid_tool_args',
            name: 'lookup',
            args: '{not-json',
          }],
        });
      }
      expect(inputMessages(input)).toHaveLength(2);
      return new AIMessageChunk('recovered after invalid tool arguments');
    });
    const loop = new AgentLoop({
      streaming: false,
      model: auditedTestModel({
        store,
        job: startedJob,
        delegate,
        workerId: 'worker_invalid_tool_args',
        nowMs: 34,
      }),
      createOutputId: () => `invalid_tool_output_${modelCalls + 1}`,
      clock: { nowMs: () => 35 },
    });
    let messageNo = 1;
    const writer = new RuntimeEventWriter({
      store,
      workerId: 'worker_invalid_tool_args',
      tools: [runtimeLookup],
      ids: {
        eventId: () => 'event_invalid_tool_args',
        messageId: () => `invalid_tool_message_${messageNo++}`,
        toolInvocationId: () => 'invocation_invalid_tool_args',
        userInputRequestId: () => 'unused_invalid_tool_input',
      },
      clock: { nowMs: () => 36 },
    });
    const execution = {
      loop,
      writer,
      jobState: jobExecutionState(store, 'worker_invalid_tool_args', 36),
    };

    const result = await executeDurableAgentLoop({
      ...execution,
      input: {
        job: startedJob,
        loopInput: {
          context: {
            loadMessages: () => loadPersistedToolMessages(store, startedJob.sessionId),
          },
          tools: {
            definitions: [runtimeLookup.tool],
            executor: new ToolExecutor({
              store,
              workerId: 'worker_invalid_tool_args',
              tools: [runtimeLookup],
              clock: { nowMs: () => 35 },
            }),
          },
          limits: { maxIterations: 3, maxToolCalls: 3, deadlineMs: 90 },
        },
      },
    });

    if (result.type !== 'completed') {
      throw new Error(JSON.stringify(result.job.error));
    }
    expect(result).toMatchObject({
      type: 'completed',
      job: { status: 'completed' },
      message: { content: 'recovered after invalid tool arguments' },
    });
    const invocation = await store.getToolInvocation(
      'job_invalid_tool_args',
      'call_invalid_tool_args'
    );
    expect(invocation).toMatchObject({
      status: 'failed',
      version: 1,
      error: { code: 'invalid_tool_arguments', message: 'Malformed args.' },
    });
    expect(invocation).not.toHaveProperty('startedAtMs');
    const messages = await store.listSessionMessages('session_invalid_tool_args');
    expect(messages.map(message => message.messageType)).toEqual([
      'user_message',
      'tool_call',
      'tool_result',
      'assistant_message',
    ]);
    expect(messages[2]).toMatchObject({
      toolCallId: 'call_invalid_tool_args',
      toolResult: { status: 'failed', error: 'Malformed args.' },
    });
    expect(await store.listModelCalls('job_invalid_tool_args')).toMatchObject([
      {
        outputId: 'invalid_tool_output_1', outputDisposition: 'accepted',
        resultType: 'tool_calls', toolNames: ['lookup'],
        resultPayload: { invalidToolCalls: [expect.objectContaining({ name: 'lookup' })] },
      },
      {
        outputId: 'invalid_tool_output_2', outputDisposition: 'accepted',
        resultType: 'text',
      },
    ]);
  });

  it('persists accepted and rejected ModelCall output dispositions', async () => {
    await store.createSession({ id: 'session_disposition', nowMs: 10 });
    await createJob(store, 'session_disposition', 'job_disposition', 'message_disposition', 20);
    const startedJob = await store.startJobExecution({
      jobId: 'job_disposition', expectedVersion: 0, workerId: 'worker_disposition',
      attemptId: 'attempt_disposition', nowMs: 30, leaseUntilMs: 100,
    });
    let modelCalls = 0;
    const model = auditedTestModel({
      store,
      job: startedJob,
      workerId: 'worker_disposition',
      delegate: new TestChatRunnable(async () => new AIMessageChunk(
        ++modelCalls === 1 ? 'premature' : 'accepted final'
      )),
      nowMs: 34,
    });
    let outputNo = 0;
    const execution = {
      loop: new AgentLoop({
        model,
        createOutputId: () => `output_disposition_${++outputNo}`,
        streaming: false,
        clock: { nowMs: () => 35 },
      }),
      writer: new RuntimeEventWriter({
        store, workerId: 'worker_disposition', tools: [], requireModelCallAudit: true,
        clock: { nowMs: () => 36 },
      }),
      jobState: jobExecutionState(store, 'worker_disposition', 36),
    };
    const result = await executeDurableAgentLoop({
      ...execution,
      input: {
        job: startedJob,
        loopInput: {
          context: { loadMessages: async () => [] },
          tools: {
            definitions: [],
            executor: { execute: async () => ({ type: 'completed', content: 'unused' }) },
          },
          policy: {
            validateFinalAnswer: async candidate => candidate.content === 'premature'
              ? { type: 'retry', feedback: 'Complete the durable work first.' }
              : { type: 'accept' },
          },
          limits: { maxIterations: 3, maxToolCalls: 1, deadlineMs: 90 },
        },
      },
    });

    expect(result).toMatchObject({ type: 'completed', message: { content: 'accepted final' } });
    expect(await store.listModelCalls('job_disposition')).toMatchObject([
      {
        outputId: 'output_disposition_1', outputDisposition: 'rejected',
        outputDispositionReason: 'Complete the durable work first.',
      },
      { outputId: 'output_disposition_2', outputDisposition: 'accepted' },
    ]);
  });

  it('runs direct HITL through waiting, answer-as-tool-result, resumed execution, and final completion', async () => {
    await store.createSession({ id: 'session_hitl', nowMs: 10 });
    await createJob(store, 'session_hitl', 'job_hitl', 'message_hitl', 20);
    const startedJob = await store.startJobExecution({
      jobId: 'job_hitl',
      expectedVersion: 0,
      workerId: 'worker_hitl',
      attemptId: 'attempt_hitl_1',
      nowMs: 30,
      leaseUntilMs: 100,
    });
    const runtimeChoose = userInputRuntimeTool('choose', {
      source: 'tool',
      answerMode: 'as_tool_result',
      prompt: 'Choose one',
      inputSchema: { type: 'single_choice', options: [{ label: 'One', value: 'one' }] },
    });
    const definition = runtimeChoose.tool;
    const toolExecutor = new ToolExecutor({
      store,
      workerId: 'worker_hitl',
      tools: [runtimeChoose],
      clock: { nowMs: () => 35 },
    });
    let messageNo = 1;
    let writerNowMs = 36;
    const writer = new RuntimeEventWriter({
      store,
      workerId: 'worker_hitl',
      tools: [runtimeChoose],
      ids: {
        eventId: () => 'event_hitl',
        messageId: () => `hitl_runtime_message_${messageNo++}`,
        toolInvocationId: () => 'hitl_invocation',
        userInputRequestId: () => 'hitl_input',
      },
      clock: { nowMs: () => writerNowMs },
    });
    const jobManager = new JobManager({
      store,
      publisher: { publish: () => undefined },
      execution: noOpExecutionSupervisor(),
      workerId: 'worker_hitl',
      clock: { nowMs: () => 40 },
      ids: {
        jobId: () => 'unused_job',
        messageId: () => 'hitl_answer_message',
        attemptId: () => 'attempt_hitl_2',
      },
    });
    const waitingExecution = {
      loop: new AgentLoop({
        streaming: false,
        model: auditedTestModel({
          store,
          job: startedJob,
          delegate: new TestChatRunnable(async () => new AIMessageChunk({
            content: '',
            tool_calls: [{ id: 'call_hitl', name: 'choose', args: {} }],
          })),
          nowMs: 35,
        }),
        createOutputId: () => 'hitl_output_1',
        clock: { nowMs: () => 35 },
      }),
      writer,
      jobState: jobExecutionState(store, 'worker_hitl', 40),
    };
    const waiting = await executeDurableAgentLoop({
      ...waitingExecution,
      input: {
        job: startedJob,
        loopInput: {
          context: {
            loadMessages: () => loadPersistedToolMessages(store, startedJob.sessionId),
          },
          tools: {
            definitions: [definition],
            executor: toolExecutor,
          },
          limits: { maxIterations: 2, maxToolCalls: 2, deadlineMs: 90 },
        },
      },
    });
    expect(waiting).toMatchObject({
      type: 'waiting_user_input',
      job: { status: 'waiting_user_input', version: 2 },
      requests: [{ id: 'hitl_input', status: 'pending', toolInvocationId: 'hitl_invocation' }],
    });
    if (waiting.type !== 'waiting_user_input') throw new Error('expected waiting result');

    const answered = await jobManager.answerUserInputRequest({
      requestId: waiting.requests[0].id,
      expectedVersion: waiting.requests[0].version,
      clientAnswerId: 'hitl_client_answer',
      answer: 'one',
    });
    expect(answered).toMatchObject({
      shouldResume: true,
      attemptId: 'attempt_hitl_2',
      job: { status: 'resuming', version: 3, currentAttemptId: 'attempt_hitl_2' },
      answerMessage: { messageType: 'tool_result', toolCallId: 'call_hitl' },
      invocation: { status: 'completed' },
    });
    writerNowMs = 42;

    const resumeExecution = {
      loop: new AgentLoop({
        streaming: false,
        model: auditedTestModel({
          store,
          job: answered.job,
          delegate: new TestChatRunnable(async () => new AIMessageChunk('resumed final answer')),
          nowMs: 41,
        }),
        createOutputId: () => 'hitl_output_2',
        clock: { nowMs: () => 41 },
      }),
      writer,
      jobState: jobExecutionState(store, 'worker_hitl', 42),
    };
    const resumed = await executeDurableAgentLoop({
      ...resumeExecution,
      input: {
        job: answered.job,
        loopInput: {
          context: {
            loadMessages: () => loadPersistedToolMessages(store, answered.job.sessionId),
          },
          tools: {
            definitions: [definition],
            executor: toolExecutor,
          },
          limits: { maxIterations: 2, maxToolCalls: 2, deadlineMs: 90 },
        },
      },
    });
    expect(resumed).toMatchObject({
      type: 'completed',
      job: { status: 'completed', version: 4 },
      message: { content: 'resumed final answer' },
    });
    expect((await store.listSessionMessages('session_hitl')).map(message => message.messageType))
      .toEqual(['user_message', 'tool_call', 'tool_result', 'assistant_message']);
    expect((await store.listModelCalls('job_hitl')).map(call => ({
      logicalCallKey: call.logicalCallKey,
      callAttemptNo: call.callAttemptNo,
      attemptId: call.attemptId,
      outputId: call.outputId,
      outputDisposition: call.outputDisposition,
    }))).toEqual([
      {
        logicalCallKey: 'job.react:1',
        callAttemptNo: 1,
        attemptId: 'attempt_hitl_1',
        outputId: 'hitl_output_1',
        outputDisposition: 'accepted',
      },
      {
        logicalCallKey: 'job.react:1',
        callAttemptNo: 2,
        attemptId: 'attempt_hitl_2',
        outputId: 'hitl_output_2',
        outputDisposition: 'accepted',
      },
    ]);
  });

  it('applies versioned Plan snapshots inside the single Job loop', async () => {
    await store.createSession({ id: 'session_plan_tool', nowMs: 10 });
    await createJob(store, 'session_plan_tool', 'job_plan_tool', 'message_plan_tool', 20);
    const job = await store.startJobExecution({
      jobId: 'job_plan_tool', expectedVersion: 0, workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', nowMs: 30, leaseUntilMs: 200,
    });
    const created = await store.applyPlanUpdate({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', planId: 'plan_tool', expectedVersion: 0,
      title: 'Research and write', goal: 'hello job_plan_tool', nowMs: 31,
      metadata: { lastToolCallId: 'call_plan_1' },
      steps: [
        { id: 'plan_step_research', key: 'research', position: 0, title: 'Research', status: 'in_progress' },
        { id: 'plan_step_write', key: 'write', position: 1, title: 'Write', status: 'pending' },
      ],
    });
    expect(created).toMatchObject({
      plan: { id: 'plan_tool', status: 'active', version: 0 },
      steps: [{ key: 'research', status: 'in_progress' }, { key: 'write', status: 'pending' }],
    });
    const replayedCreate = await store.applyPlanUpdate({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', planId: 'plan_tool', expectedVersion: 0,
      title: 'Research and write', goal: 'hello job_plan_tool', nowMs: 32,
      metadata: { lastToolCallId: 'call_plan_1' },
      steps: [
        { id: 'plan_step_research', key: 'research', position: 0, title: 'Research', status: 'in_progress' },
        { id: 'plan_step_write', key: 'write', position: 1, title: 'Write', status: 'pending' },
      ],
    });
    expect(replayedCreate.plan).toMatchObject({ version: 0, updatedAtMs: 31 });

    const advanced = await store.applyPlanUpdate({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', planId: 'plan_tool', expectedVersion: 0,
      title: 'Research and write', goal: 'hello job_plan_tool', nowMs: 32,
      metadata: { lastToolCallId: 'call_plan_2' },
      steps: [
        {
          id: 'plan_step_research', key: 'research', position: 0, title: 'Research',
          status: 'completed', result: { summary: 'Sources verified' },
        },
        { id: 'plan_step_write', key: 'write', position: 1, title: 'Write', status: 'in_progress' },
      ],
    });
    expect(advanced).toMatchObject({
      plan: { status: 'active', version: 1 },
      steps: [
        { key: 'research', status: 'completed', result: { summary: 'Sources verified' } },
        { key: 'write', status: 'in_progress' },
      ],
    });
    await store.commitModelToolCalls({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', outputId: 'output_plan_write',
      messageId: 'message_plan_write_call', content: '', nowMs: 32,
      invocations: [{
        invocationId: 'invocation_plan_write',
        call: { id: 'call_plan_write', name: 'write_article', args: { title: 'Report' } },
        argumentsChecksum: checksumToolArguments({ title: 'Report' }),
        sideEffectLevel: 'idempotent', idempotencyKey: 'job_plan_tool:call_plan_write',
      }],
    });
    await store.tryStartToolExecution({
      jobId: job.id, toolCallId: 'call_plan_write', workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', nowMs: 32,
    });
    await store.commitToolResult({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', toolCallId: 'call_plan_write',
      messageId: 'message_plan_write_result', nowMs: 32,
      outcome: {
        status: 'completed', content: 'written', result: { path: 'artifacts/report.md' },
        durationMs: 1,
        artifacts: [{
          id: 'artifact_plan_write', kind: 'file', area: 'artifacts', title: 'Report',
          fileName: 'report.md', logicalPath: 'artifacts/report.md',
          storagePath: '.revisions/invocation_plan_write/artifacts/report.md',
          mediaType: 'text/markdown', size: 100, checksum: 'checksum_report',
        }],
      },
    });
    expect(await store.listPlanSteps('plan_tool')).toMatchObject([
      { key: 'research' },
      {
        key: 'write',
        result: {
          evidenceMessageIds: ['message_plan_write_result'],
          artifactIds: ['artifact_plan_write'],
        },
      },
    ]);
    await expect(store.applyPlanUpdate({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', planId: 'plan_tool', expectedVersion: 1,
      title: 'Research and write', goal: 'hello job_plan_tool', nowMs: 33,
      steps: [
        { id: 'plan_step_research', key: 'research', position: 0, title: 'Research', status: 'pending' },
        { id: 'plan_step_write', key: 'write', position: 1, title: 'Write', status: 'in_progress' },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_PLAN_STATE' });

    const completed = await store.applyPlanUpdate({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', planId: 'plan_tool', expectedVersion: 1,
      title: 'Research and write', goal: 'hello job_plan_tool', nowMs: 34,
      metadata: { lastToolCallId: 'call_plan_3' },
      steps: [
        {
          id: 'plan_step_research', key: 'research', position: 0, title: 'Research',
          status: 'completed', result: { summary: 'Sources verified' },
        },
        {
          id: 'plan_step_write', key: 'write', position: 1, title: 'Write',
          status: 'completed',
          result: {
            summary: 'Report written',
            evidenceMessageIds: ['message_hallucinated_by_model'],
            artifactIds: ['artifact_hallucinated_by_model'],
          },
        },
      ],
    });
    expect(completed.plan).toMatchObject({ status: 'completed', version: 2 });
    expect(completed.steps[1]).toMatchObject({
      result: {
        summary: 'Report written',
        evidenceMessageIds: ['message_plan_write_result'],
        artifactIds: ['artifact_plan_write'],
      },
    });
    await expect(store.applyPlanUpdate({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', planId: 'plan_tool', expectedVersion: 2,
      title: 'Reopen completed work', goal: 'hello job_plan_tool', nowMs: 35,
      metadata: { lastToolCallId: 'call_plan_4' },
      steps: [
        {
          id: 'plan_step_research', key: 'research', position: 0, title: 'Research',
          status: 'completed', result: { summary: 'Sources verified' },
        },
        {
          id: 'plan_step_write', key: 'write', position: 1, title: 'Write',
          status: 'completed', result: { summary: 'Report written' },
        },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_PLAN_STATE' });
    await expect(store.completeJobWithFinalMessage({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_plan_tool',
      attemptId: 'attempt_plan_tool', outputId: 'output_plan_tool',
      messageId: 'message_plan_tool_final', content: 'Report complete', nowMs: 36,
    })).resolves.toMatchObject({
      job: { status: 'completed' },
      message: { messageType: 'assistant_message', channel: 'final' },
    });
  });

  it('audits ModelCalls, accumulates usage, abandons orphaned calls, and replaces summaries', async () => {
    await store.createSession({ id: 'session_audit', nowMs: 10 });
    await createJob(store, 'session_audit', 'job_audit', 'message_audit', 20);
    const job = await store.startJobExecution({
      jobId: 'job_audit', expectedVersion: 0, workerId: 'worker_audit',
      attemptId: 'attempt_audit', nowMs: 30, leaseUntilMs: 200,
    });
    const manifest = {
      purpose: 'job_execution',
      contextRulesVersion: 'context-v1',
      systemPromptVersion: 'system-v1',
      messageGroupIds: [],
      summaryIds: [],
      fixedPrefixChecksum: 'prefix',
      estimatedBreakdown: {
        system: 10, tools: 0, summaries: 0, messages: 70, reservedOutput: 10,
      },
    };
    await store.startModelCall({
      id: 'model_call_1', sessionId: 'session_audit', jobId: job.id,
      attemptId: 'attempt_audit', workerId: 'worker_audit',
      logicalCallKey: 'job.react:1', callAttemptNo: 1, callType: 'job.react',
      provider: 'test', model: 'test-model', contextRulesVersion: 'context-v1',
      inputManifest: manifest, inputMessages: [], inputChecksum: 'checksum_1',
      maxContextTokens: 100, reservedOutputTokens: 10, estimatedInputTokens: 80, nowMs: 31,
    });
    const completed = await store.completeModelCall({
      id: 'model_call_1', status: 'completed', usageSource: 'provider',
      actualInputTokens: 95, actualOutputTokens: 5, actualTotalTokens: 100,
      outputId: 'output_audit', resultType: 'text', resultPayload: { content: 'done' }, nowMs: 32,
    });
    expect(completed).toMatchObject({
      call: { status: 'completed', actualTotalTokens: 100 },
      usage: {
        totalModelCalls: 1,
        totalEstimatedInputTokens: 80,
        totalActualInputTokens: 95,
        totalActualOutputTokens: 5,
        totalTokens: 100,
        warningLevel: 'critical',
      },
    });
    await store.startModelCall({
      id: 'model_call_2', sessionId: 'session_audit', jobId: job.id,
      attemptId: 'attempt_audit', workerId: 'worker_audit',
      logicalCallKey: 'job.react:2', callAttemptNo: 1, callType: 'job.react',
      provider: 'test', model: 'test-model', contextRulesVersion: 'context-v1',
      inputManifest: manifest, inputMessages: [], inputChecksum: 'checksum_2',
      maxContextTokens: 100, reservedOutputTokens: 10, estimatedInputTokens: 10, nowMs: 33,
    });
    await expect(store.abandonStartedModelCalls(201)).resolves.toMatchObject([{
      id: 'model_call_2', status: 'failed', errorCode: 'model_call_abandoned',
    }]);
    expect(await store.getModelUsageStats('session_audit')).toMatchObject({
      totalModelCalls: 2,
      totalEstimatedInputTokens: 90,
      totalTokens: 100,
    });
    expect(await store.listRecentSessionModelCalls('session_audit', 1)).toMatchObject([{
      id: 'model_call_2', status: 'failed',
    }]);
    expect((await store.listRecentSessionModelCalls('session_audit', 100)).map(call => call.id))
      .toEqual(['model_call_1', 'model_call_2']);

    const firstSummary = await store.replaceContextSummary({
      id: 'summary_audit_1', sessionId: 'session_audit',
      ownerType: 'session', ownerId: 'session_audit', purpose: 'conversation',
      contextRulesVersion: 'context-v1', summaryType: 'rolling',
      sourceRowIdStart: 1, sourceRowIdEnd: 1, summary: 'first', summaryFormat: 'markdown',
      sourceMessageCount: 1, compressionPromptVersion: 'compress-v1', checksum: 'sum_1', nowMs: 35,
    });
    const secondSummary = await store.replaceContextSummary({
      id: 'summary_audit_2', sessionId: 'session_audit',
      ownerType: 'session', ownerId: 'session_audit', purpose: 'conversation',
      contextRulesVersion: 'context-v1', summaryType: 'rolling',
      sourceRowIdStart: 1, sourceRowIdEnd: 2, parentSummaryId: firstSummary.id,
      summary: 'second', summaryFormat: 'markdown', sourceMessageCount: 2,
      compressionPromptVersion: 'compress-v1', checksum: 'sum_2', nowMs: 36,
    });
    expect(secondSummary).toMatchObject({ replacesSummaryId: 'summary_audit_1', status: 'active' });
    expect(await store.listActiveContextSummaries(
      'session', 'session_audit', 'conversation', 'context-v1'
    )).toEqual([secondSummary]);
    expect((await store.getContextSummariesByIds([
      'summary_audit_2', 'summary_audit_1', 'missing_summary',
    ])).map(summary => [summary.id, summary.status])).toEqual([
      ['summary_audit_2', 'active'],
      ['summary_audit_1', 'superseded'],
    ]);
    expect((await pool!.query(
      `select status from agent_context_summaries where id = 'summary_audit_1'`
    )).rows[0]).toEqual({ status: 'superseded' });
  });

  it('fails descendants atomically, preserves side-effect uncertainty, and creates retry as a new Job', async () => {
    await store.createSession({ id: 'session_fail', nowMs: 10 });
    await createJob(store, 'session_fail', 'job_fail', 'message_fail', 20);
    const startedJob = await store.startJobExecution({
      jobId: 'job_fail',
      expectedVersion: 0,
      workerId: 'worker_fail',
      attemptId: 'attempt_fail',
      nowMs: 30,
      leaseUntilMs: 100,
    });
    await seedRunningDescendants(pool!, startedJob.currentAttemptId!);

    const failed = await store.failJob({
      jobId: startedJob.id,
      expectedVersion: startedJob.version,
      workerId: startedJob.leaseOwner!,
      attemptId: startedJob.currentAttemptId!,
      error: { code: 'model_failed', message: 'model unavailable' },
      nowMs: 40,
    });
    expect(failed).toMatchObject({
      status: 'failed',
      version: 2,
      completedAtMs: 40,
      error: { code: 'model_failed' },
    });
    expect(failed).not.toHaveProperty('leaseOwner');

    const descendantStates = await pool!.query(
      `select
         (select status from agent_plans where id = 'plan_fail') as plan_status,
         (select status from agent_plan_steps where id = 'step_fail') as step_status,
         (select status from agent_tool_invocations where id = 'invocation_side') as side_status,
         (select error_code from agent_tool_invocations where id = 'invocation_side') as side_error_code,
         (select status from agent_tool_invocations where id = 'invocation_read') as read_status,
         (select status from agent_user_input_requests where id = 'input_fail') as input_status`
    );
    expect(descendantStates.rows[0]).toEqual({
      plan_status: 'failed',
      step_status: 'failed',
      side_status: 'unknown',
      side_error_code: 'side_effect_status_unknown',
      read_status: 'cancelled',
      input_status: 'cancelled',
    });

    const messageCountBeforeRetry = (await store.listSessionMessages('session_fail')).length;
    const retry = await store.createRetryJob({
      sessionId: 'session_fail',
      jobId: 'job_retry',
      retryOfJobId: 'job_fail',
      jobMetadata: { goalMessageId: 'message_fail' },
      nowMs: 50,
    });
    expect(retry.job).toMatchObject({
      id: 'job_retry',
      retryOfJobId: 'job_fail',
      status: 'created',
    });
    expect(await store.listSessionMessages('session_fail')).toHaveLength(messageCountBeforeRetry);
  });

  it('cancels a created Job without requiring a lease', async () => {
    await store.createSession({ id: 'session_cancel', nowMs: 10 });
    await createJob(store, 'session_cancel', 'job_cancel', 'message_cancel', 20);

    await expect(store.cancelJob({
      jobId: 'job_cancel',
      expectedVersion: 0,
      nowMs: 30,
    })).resolves.toMatchObject({
      status: 'cancelled',
      version: 1,
      completedAtMs: 30,
    });
  });

  it('lists created and lease-expired Jobs for runtime recovery', async () => {
    await store.createSession({ id: 'session_recover_created', nowMs: 10 });
    await createJob(store, 'session_recover_created', 'job_recover_created', 'message_created', 20);

    await store.createSession({ id: 'session_recover_expired', nowMs: 11 });
    await createJob(store, 'session_recover_expired', 'job_recover_expired', 'message_expired', 21);
    await store.startJobExecution({
      jobId: 'job_recover_expired', expectedVersion: 0, workerId: 'worker_dead',
      attemptId: 'attempt_expired', nowMs: 30, leaseUntilMs: 100,
    });

    await store.createSession({ id: 'session_recover_live', nowMs: 12 });
    await createJob(store, 'session_recover_live', 'job_recover_live', 'message_live', 22);
    await store.startJobExecution({
      jobId: 'job_recover_live', expectedVersion: 0, workerId: 'worker_live',
      attemptId: 'attempt_live', nowMs: 31, leaseUntilMs: 101,
    });

    await expect(store.listJobsNeedingRuntimeRecovery({
      nowMs: 100, createdBeforeMs: 100, limit: 10,
    })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'job_recover_created', status: 'created' }),
        expect.objectContaining({ id: 'job_recover_expired', status: 'running' }),
      ])
    );
    const recoverableIds = (await store.listJobsNeedingRuntimeRecovery({
      nowMs: 100, createdBeforeMs: 100, limit: 10,
    }))
      .map(job => job.id);
    expect(recoverableIds).not.toContain('job_recover_live');
  });

  it('resumes a checkpointed tool batch and retries only safe interrupted invocations', async () => {
    await store.createSession({ id: 'session_checkpoint_resume', nowMs: 10 });
    await createJob(
      store,
      'session_checkpoint_resume',
      'job_checkpoint_resume',
      'message_checkpoint_resume',
      20
    );
    const firstAttempt = await store.startJobExecution({
      jobId: 'job_checkpoint_resume', expectedVersion: 0, workerId: 'worker_dead',
      attemptId: 'attempt_checkpoint_1', nowMs: 30, leaseUntilMs: 100,
    });
    await store.commitModelToolCalls({
      sessionId: firstAttempt.sessionId,
      jobId: firstAttempt.id,
      workerId: 'worker_dead',
      attemptId: 'attempt_checkpoint_1',
      outputId: 'output_checkpoint_tools',
      messageId: 'message_checkpoint_tools',
      content: '',
      nowMs: 40,
      invocations: [
        {
          invocationId: 'invocation_checkpoint_1',
          call: { id: 'call_checkpoint_1', name: 'get_current_time', args: {} },
          argumentsChecksum: checksumToolArguments({}),
          sideEffectLevel: 'read_only',
          idempotencyKey: 'job_checkpoint_resume:call_checkpoint_1',
        },
        {
          invocationId: 'invocation_checkpoint_2',
          call: { id: 'call_checkpoint_2', name: 'read_file', args: { path: 'docs/a.md' } },
          argumentsChecksum: checksumToolArguments({ path: 'docs/a.md' }),
          sideEffectLevel: 'read_only',
          idempotencyKey: 'job_checkpoint_resume:call_checkpoint_2',
        },
      ],
    });
    await store.tryStartToolExecution({
      jobId: firstAttempt.id,
      toolCallId: 'call_checkpoint_1',
      workerId: 'worker_dead',
      attemptId: 'attempt_checkpoint_1',
      nowMs: 50,
    });

    const expired = (await store.getJob(firstAttempt.id))!;
    const paused = await store.markJobRecoveryRequired({
      jobId: expired.id, expectedVersion: expired.version, nowMs: 101,
    });
    const resumed = await store.startJobExecution({
      jobId: paused.id,
      expectedVersion: paused.version,
      workerId: 'worker_recovery',
      attemptId: 'attempt_checkpoint_2',
      nowMs: 101,
      leaseUntilMs: 200,
    });
    const prepared = await store.prepareToolInvocationsForRecovery({
      jobId: resumed.id,
      workerId: 'worker_recovery',
      attemptId: 'attempt_checkpoint_2',
      nowMs: 102,
    });

    expect(prepared.blockedInvocations).toEqual([]);
    expect(prepared.checkpoint).toMatchObject({
      phase: 'tool_batch',
      callMessageId: 'message_checkpoint_tools',
      iterationNo: 1,
      executedToolCalls: 2,
    });
    expect(prepared.invocations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolCallId: 'call_checkpoint_1', status: 'pending', attemptId: 'attempt_checkpoint_2',
        executionAttemptNo: 1,
      }),
      expect.objectContaining({
        toolCallId: 'call_checkpoint_2', status: 'pending', attemptId: 'attempt_checkpoint_2',
        executionAttemptNo: 0,
      }),
    ]));
    await expect(pool!.query(
      `select status from agent_tool_execution_attempts
       where invocation_id = 'invocation_checkpoint_1' and attempt_no = 1`
    )).resolves.toMatchObject({ rows: [{ status: 'interrupted' }] });
  });

  it('marks an interrupted side-effecting tool unknown instead of replaying it', async () => {
    await store.createSession({ id: 'session_checkpoint_unknown', nowMs: 10 });
    await createJob(
      store,
      'session_checkpoint_unknown',
      'job_checkpoint_unknown',
      'message_checkpoint_unknown',
      20
    );
    const firstAttempt = await store.startJobExecution({
      jobId: 'job_checkpoint_unknown', expectedVersion: 0, workerId: 'worker_dead',
      attemptId: 'attempt_unknown_1', nowMs: 30, leaseUntilMs: 100,
    });
    const args = { command: 'deploy' };
    await store.commitModelToolCalls({
      sessionId: firstAttempt.sessionId,
      jobId: firstAttempt.id,
      workerId: 'worker_dead',
      attemptId: 'attempt_unknown_1',
      outputId: 'output_unknown',
      messageId: 'message_unknown',
      content: '',
      nowMs: 40,
      invocations: [{
        invocationId: 'invocation_unknown',
        call: { id: 'call_unknown', name: 'run_shell', args },
        argumentsChecksum: checksumToolArguments(args),
        sideEffectLevel: 'side_effecting',
        idempotencyKey: 'job_checkpoint_unknown:call_unknown',
      }],
    });
    await store.tryStartToolExecution({
      jobId: firstAttempt.id,
      toolCallId: 'call_unknown',
      workerId: 'worker_dead',
      attemptId: 'attempt_unknown_1',
      nowMs: 50,
    });
    const expired = (await store.getJob(firstAttempt.id))!;
    const paused = await store.markJobRecoveryRequired({
      jobId: expired.id, expectedVersion: expired.version, nowMs: 101,
    });
    const resumed = await store.startJobExecution({
      jobId: paused.id,
      expectedVersion: paused.version,
      workerId: 'worker_recovery',
      attemptId: 'attempt_unknown_2',
      nowMs: 101,
      leaseUntilMs: 200,
    });
    const prepared = await store.prepareToolInvocationsForRecovery({
      jobId: resumed.id,
      workerId: 'worker_recovery',
      attemptId: 'attempt_unknown_2',
      nowMs: 102,
    });

    expect(prepared.blockedInvocations).toEqual([
      expect.objectContaining({ toolCallId: 'call_unknown', status: 'unknown' }),
    ]);
    expect(await store.getToolInvocation(resumed.id, 'call_unknown')).toMatchObject({
      status: 'unknown',
      error: { code: 'side_effect_status_unknown' },
    });
  });

  it('allows a cancelled Job to be continued as a new retry Job', async () => {
    await store.createSession({ id: 'session_cancel_retry', nowMs: 10 });
    await createJob(store, 'session_cancel_retry', 'job_cancel_retry', 'message_cancel_retry', 20);
    await store.cancelJob({ jobId: 'job_cancel_retry', expectedVersion: 0, nowMs: 30 });

    await expect(store.createRetryJob({
      sessionId: 'session_cancel_retry',
      jobId: 'job_after_cancel',
      retryOfJobId: 'job_cancel_retry',
      jobMetadata: { goalMessageId: 'message_cancel_retry' },
      nowMs: 40,
    })).resolves.toMatchObject({
      job: { id: 'job_after_cancel', status: 'created', retryOfJobId: 'job_cancel_retry' },
    });
  });
});

class TestChatRunnable extends Runnable<BaseLanguageModelInput, AIMessageChunk> {
  static lc_name(): string { return 'TestChatRunnable'; }
  readonly lc_namespace = ['agent_runtime', 'tests'];

  constructor(
    private readonly handler: (
      input: BaseLanguageModelInput,
      options?: Partial<RunnableConfig>
    ) => Promise<AIMessageChunk>
  ) {
    super();
  }

  invoke(
    input: BaseLanguageModelInput,
    options?: Partial<RunnableConfig>
  ): Promise<AIMessageChunk> {
    return this.handler(input, options);
  }
}

function inputMessages(input: BaseLanguageModelInput): BaseMessage[] {
  if (Array.isArray(input)) return input.map(coerceMessageLikeToMessage);
  if (typeof input === 'string') return [coerceMessageLikeToMessage(['human', input])];
  return input.toChatMessages();
}

async function loadPersistedToolMessages(
  store: PostgresAgentStore,
  sessionId: string
): Promise<BaseMessage[]> {
  const [messages, invocations] = await Promise.all([
    store.listSessionMessages(sessionId),
    store.listSessionToolInvocations(sessionId),
  ]);
  const formatter = new ContextFormatter();
  return new MessageGroupBuilder()
    .build(messages, invocations)
    .groups
    .filter(group => group.type === 'tool_exchange')
    .flatMap(group => formatter.formatGroup(group));
}

function auditedTestModel(input: {
  store: PostgresAgentStore;
  job: { sessionId: string; id: string; currentAttemptId?: string; attemptNo: number };
  delegate: TestChatRunnable;
  workerId?: string;
  nowMs: number;
}): AuditedChatModel {
  return new AuditedChatModel({
    delegate: input.delegate,
    store: input.store,
    workerId: input.workerId ?? 'worker_hitl',
    target: {
      sessionId: input.job.sessionId,
      jobId: input.job.id,
      attemptId: input.job.currentAttemptId!,
      attemptNo: input.job.attemptNo,
    },
    callType: 'job.react',
    logicalCallKey: 'job.react',
    provider: 'test',
    model: 'test-model',
    maxContextTokens: 1_000,
    reservedOutputTokens: 100,
    baseManifest: {
      purpose: 'job_execution',
      contextRulesVersion: 'context-v1',
      systemPromptVersion: 'system-v1',
      messageGroupIds: [],
      summaryIds: [],
      fixedPrefixChecksum: 'prefix',
      estimatedBreakdown: {
        system: 10,
        tools: 10,
        summaries: 0,
        messages: 10,
        reservedOutput: 100,
      },
    },
    clock: { nowMs: () => input.nowMs },
  });
}

function completedRuntimeTool(
  name: string,
  handler: (
    input: Record<string, unknown>,
    context: RuntimeToolContext
  ) => Promise<{ content: string; result: unknown }>
): RuntimeTool {
  return {
    sideEffectLevel: 'read_only',
    tool: new DynamicStructuredTool({
      name,
      description: `${name} test tool`,
      schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        additionalProperties: true,
      } as const,
      responseFormat: 'content_and_artifact',
      func: async (input, _runManager, config) => {
        const context = config?.configurable?.agentRuntimeContext as RuntimeToolContext;
        const result = await handler(input as Record<string, unknown>, context);
        return [result.content, result.result];
      },
    }),
  };
}

function userInputRuntimeTool(
  name: string,
  request: RuntimeUserInputArtifact['request']
): RuntimeTool {
  return {
    sideEffectLevel: 'read_only',
    tool: new DynamicStructuredTool({
      name,
      description: `${name} test tool`,
      schema: { type: 'object', additionalProperties: true } as const,
      responseFormat: 'content_and_artifact',
      func: async () => [
        'User input is required.',
        { type: 'requires_user_input', request } satisfies RuntimeUserInputArtifact,
      ],
    }),
  };
}

async function createJob(
  store: PostgresAgentStore,
  sessionId: string,
  jobId: string,
  userMessageId: string,
  nowMs: number
) {
  return store.createJobAndAppendUserMessage({
    sessionId,
    jobId,
    userMessageId,
    content: `hello ${jobId}`,
    nowMs,
  });
}

function noOpExecutionSupervisor(): JobExecutionSupervisorPort {
  return {
    start: async () => undefined,
    startExecution: async () => undefined,
    abortExecution: () => undefined,
    shutdown: async () => undefined,
  };
}

function jobExecutionState(
  store: PostgresAgentStore,
  workerId: string,
  nowMs: number
): JobExecutionStatePort {
  return {
    getJob: jobId => store.getJob(jobId),
    failJob: (job, error) => {
      if (!job.currentAttemptId) throw new Error(`Job ${job.id} has no active attempt.`);
      return store.failJob({
        jobId: job.id,
        expectedVersion: job.version,
        workerId,
        attemptId: job.currentAttemptId,
        error,
        nowMs,
      });
    },
    cancelJob: (jobId, expectedVersion) => store.cancelJob({
      jobId,
      expectedVersion,
      nowMs,
    }),
  };
}

function pendingInvocation(
  invocationId: string,
  toolCallId: string,
  toolName: string
) {
  const args = toolName === 'lookup' ? { query: 'docs' } : {};
  return {
    invocationId,
    call: {
      id: toolCallId,
      name: toolName,
      args,
    },
    argumentsChecksum: checksumToolArguments(args),
    sideEffectLevel: 'read_only' as const,
    idempotencyKey: `${invocationId}_idempotency`,
  };
}

async function seedRunningDescendants(pool: Pool, attemptId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `insert into agent_plans(
         id, session_id, job_id, title, goal, status, version, created_at_ms, updated_at_ms
       ) values ('plan_fail', 'session_fail', 'job_fail', 'Plan', 'Goal', 'active', 0, 31, 31)`
    );
    await client.query(
      `insert into agent_plan_steps(
         id, plan_id, key, position, title, description, status,
         version, created_at_ms, updated_at_ms
       ) values (
         'step_fail', 'plan_fail', 'work', 0, 'Step', 'Do it', 'in_progress',
         0, 32, 32
       )`
    );
    await client.query(
      `insert into agent_messages(
         id, session_id, job_id, plan_id, plan_step_id, attempt_id,
         role, message_type, visibility, channel, content, tool_calls, created_at_ms
       ) values (
         'tool_calls_fail', 'session_fail', 'job_fail', 'plan_fail', 'step_fail', $1,
         'assistant', 'tool_call', 'ui', 'normal', '',
         '[{"id":"call_side","name":"write","args":{}},{"id":"call_read","name":"read","args":{}}]'::jsonb,
         34
       )`,
      [attemptId]
    );
    for (const invocation of [
      { id: 'invocation_side', toolCallId: 'call_side', tool: 'write', sideEffect: 'side_effecting' },
      { id: 'invocation_read', toolCallId: 'call_read', tool: 'read', sideEffect: 'read_only' },
    ]) {
      await insertRunningInvocation(client, invocation, attemptId);
    }
    await client.query(
      `insert into agent_user_input_requests(
         id, session_id, job_id, plan_id, plan_step_id,
         source, answer_mode, status, prompt, input_schema,
         version, created_at_ms, updated_at_ms
       ) values (
         'input_fail', 'session_fail', 'job_fail', 'plan_fail', 'step_fail',
         'agent', 'as_user_message', 'pending', 'Continue?', '{"type":"approval"}'::jsonb,
         0, 36, 36
       )`
    );
  } finally {
    client.release();
  }
}

async function insertRunningInvocation(
  client: PoolClient,
  invocation: { id: string; toolCallId: string; tool: string; sideEffect: string },
  attemptId: string
): Promise<void> {
  await client.query(
    `insert into agent_tool_invocations(
       id, session_id, job_id, plan_id, plan_step_id, attempt_id,
       call_message_id, tool_call_id, tool_name, arguments, arguments_checksum,
       side_effect_level, idempotency_key, status, version,
       created_at_ms, started_at_ms, updated_at_ms
     ) values (
       $1, 'session_fail', 'job_fail', 'plan_fail', 'step_fail', $2,
       'tool_calls_fail', $3, $4, '{}'::jsonb, $1,
       $5, $1, 'running', 0,
       35, 35, 35
     )`,
    [invocation.id, attemptId, invocation.toolCallId, invocation.tool, invocation.sideEffect]
  );
}
