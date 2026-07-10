import { Pool, type PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobCoordinator } from '../src/runtime/job-coordinator.js';
import { ToolExecutor } from '../src/runtime/tool-executor.js';
import { AgentLoop } from '../src/agent-loop/agent-loop.js';
import { AgentRunner } from '../src/runtime/agent-runner.js';
import { RuntimeEventWriter } from '../src/runtime/runtime-event-writer.js';
import type { AgentRealtimeEvent } from '../src/domain/index.js';
import { checksumToolArguments } from '../src/runtime/transaction-commands.js';
import { StepRunner } from '../src/planner/step-runner.js';
import { PlanEngine } from '../src/planner/plan-engine.js';
import { PlanSummarizer } from '../src/planner/plan-summarizer.js';
import { SessionView } from '../src/view/session-view.js';
import { PostgresAgentStore } from '../src/storage/postgres/postgres-agent-store.js';
import { applyAgentRuntimeSchemaV1 } from '../src/storage/postgres/schema-v1.js';
import { RuntimeJobExecutionService } from '../src/server/runtime/job-execution.service.js';
import type { AgentLoopModelPort } from '../src/agent-loop/model-port.js';

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
    await store.createSession({ id: 'session_create', mode: 'agent', nowMs: 10 });

    const result = await createJob(store, 'session_create', 'job_create', 'message_create', 20);

    expect(result.session).toMatchObject({ version: 1, updatedAtMs: 20 });
    expect(result.job).toMatchObject({
      id: 'job_create',
      sessionId: 'session_create',
      stage: 'routing',
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
    await store.createSession({ id: 'session_conflict', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_conflict', 'job_first', 'message_first', 20);

    await expect(
      createJob(store, 'session_conflict', 'job_second', 'message_second', 30)
    ).rejects.toMatchObject({ code: 'ACTIVE_JOB_CONFLICT' });

    expect(await store.getJob('job_second')).toBeUndefined();
    expect(await store.listSessionMessages('session_conflict')).toHaveLength(1);
    expect(await store.getSession('session_conflict')).toMatchObject({ version: 1, updatedAtMs: 20 });
  });

  it('replays an identical clientRequestId and rejects payload drift', async () => {
    await store.createSession({ id: 'session_idempotent', mode: 'agent', nowMs: 10 });
    const coordinator = new JobCoordinator({
      store,
      workerId: 'worker_idempotent',
      clock: { nowMs: () => 20 },
    });
    const first = await coordinator.createJob({
      sessionId: 'session_idempotent',
      jobId: 'job_idempotent',
      userMessageId: 'message_idempotent',
      clientRequestId: 'request_idempotent',
      content: 'same payload',
    });
    const replay = await coordinator.createJob({
      sessionId: 'session_idempotent',
      jobId: 'job_unused',
      userMessageId: 'message_unused',
      clientRequestId: 'request_idempotent',
      content: 'same payload',
    });
    expect(replay).toEqual(first);
    expect(await store.listSessionMessages('session_idempotent')).toHaveLength(1);

    await expect(coordinator.createJob({
      sessionId: 'session_idempotent',
      clientRequestId: 'request_idempotent',
      content: 'changed payload',
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('allows exactly one concurrent claim and rejects stale or foreign renewals', async () => {
    await store.createSession({ id: 'session_claim', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_claim', 'job_claim', 'message_claim', 20);

    const claims = await Promise.allSettled([
      store.claimJob({
        jobId: 'job_claim',
        expectedVersion: 0,
        workerId: 'worker_a',
        attemptId: 'attempt_a',
        nowMs: 30,
        leaseUntilMs: 100,
      }),
      store.claimJob({
        jobId: 'job_claim',
        expectedVersion: 0,
        workerId: 'worker_b',
        attemptId: 'attempt_b',
        nowMs: 30,
        leaseUntilMs: 100,
      }),
    ]);
    const fulfilled = claims.filter(result => result.status === 'fulfilled');
    const rejected = claims.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CONCURRENCY_CONFLICT',
    });

    const claimed = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.claimJob>>>).value;
    await expect(store.renewJobLease({
      jobId: claimed.id,
      expectedVersion: claimed.version,
      workerId: claimed.leaseOwner!,
      attemptId: 'foreign_attempt',
      nowMs: 40,
      leaseUntilMs: 120,
    })).rejects.toMatchObject({ code: 'JOB_LEASE_LOST' });

    const renewed = await store.renewJobLease({
      jobId: claimed.id,
      expectedVersion: claimed.version,
      workerId: claimed.leaseOwner!,
      attemptId: claimed.currentAttemptId!,
      nowMs: 40,
      leaseUntilMs: 120,
    });
    expect(renewed).toMatchObject({ version: 2, leaseExpiresAtMs: 120, attemptNo: 1 });

    const recovered = await store.claimJob({
      jobId: renewed.id,
      expectedVersion: renewed.version,
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
    await store.createSession({ id: 'session_tools', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_tools', 'job_tools', 'message_tools', 20);
    const job = await store.claimJob({
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
      tools: [{
        definition: {
          name: 'lookup',
          description: 'lookup',
          schema: { type: 'object' },
          sideEffectLevel: 'read_only',
        },
        execute: async arguments_ => ({
          type: 'completed',
          content: `found:${arguments_.query}`,
          result: { found: true },
        }),
      }],
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

  it('rejects ToolInvocation claim after the Job lease is lost', async () => {
    await store.createSession({ id: 'session_tool_fence', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_tool_fence', 'job_tool_fence', 'message_tool_fence', 20);
    const job = await store.claimJob({
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
    await store.createSession({ id: 'session_inputs', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_inputs', 'job_inputs', 'message_inputs', 20);
    const job = await store.claimJob({
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
    await store.claimToolInvocation({
      jobId: 'job_inputs',
      toolCallId: 'call_input_a',
      workerId: 'worker_inputs',
      attemptId: 'attempt_inputs',
      nowMs: 32,
    });
    await store.claimToolInvocation({
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
      store.answerInputAndClaimResume({
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
      store.answerInputAndClaimResume({
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

    await expect(store.answerInputAndClaimResume({
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
    await expect(store.answerInputAndClaimResume({
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
    await store.createSession({ id: 'session_direct', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_direct', 'job_direct', 'message_direct', 20);
    const claimed = await store.claimJob({
      jobId: 'job_direct',
      expectedVersion: 0,
      workerId: 'worker_direct',
      attemptId: 'attempt_direct',
      nowMs: 30,
      leaseUntilMs: 100,
    });
    const definition = {
      name: 'lookup',
      description: 'lookup docs',
      schema: { type: 'object' },
      sideEffectLevel: 'read_only' as const,
    };
    let durableBeforeExternalExecution = false;
    const toolExecutor = new ToolExecutor({
      store,
      workerId: 'worker_direct',
      tools: [{
        definition,
        execute: async (_arguments, context) => {
          durableBeforeExternalExecution = (
            await store.getToolInvocation(context.jobId, context.toolCallId)
          )?.status === 'running';
          return { type: 'completed', content: 'lookup result', result: { value: 42 } };
        },
      }],
      clock: { nowMs: () => 35 },
    });
    let modelCalls = 0;
    const loop = new AgentLoop({
      streaming: false,
      model: {
        invoke: async request => {
          modelCalls += 1;
          if (modelCalls === 1) {
            expect(request.messages).toHaveLength(0);
            return {
              toolCalls: [{ id: 'call_direct', name: 'lookup', args: { query: 'runtime' } }],
            };
          }
          expect(request.messages).toHaveLength(2);
          return { content: 'final direct answer' };
        },
      },
      clock: { nowMs: () => 35 },
    });
    const published: AgentRealtimeEvent[] = [];
    let messageNo = 1;
    let invocationNo = 1;
    const writer = new RuntimeEventWriter({
      store,
      workerId: 'worker_direct',
      tools: [definition],
      publisher: { publish: event => { published.push(event); } },
      ids: {
        eventId: () => 'event_direct',
        messageId: () => `runtime_message_${messageNo++}`,
        toolInvocationId: () => `runtime_invocation_${invocationNo++}`,
        userInputRequestId: () => 'runtime_input_1',
      },
      clock: { nowMs: () => 36 },
    });
    const coordinator = new JobCoordinator({
      store,
      workerId: 'worker_direct',
      clock: { nowMs: () => 36 },
    });
    const runner = new AgentRunner({ loop, writer, coordinator });
    let outputNo = 1;

    const result = await runner.runDirect({
      job: claimed,
      messages: [],
      tools: [definition],
      toolExecutor,
      outputIdFactory: () => `runtime_output_${outputNo++}`,
      limits: { maxIterations: 4, maxToolCalls: 4, deadlineMs: 90 },
    });

    expect(durableBeforeExternalExecution).toBe(true);
    expect(result).toMatchObject({
      type: 'completed',
      job: {
        id: 'job_direct',
        strategy: 'direct',
        stage: 'direct_execution',
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
      'message.upserted',
      'job.upserted',
    ]);
    const directView = await new SessionView(store, { nowMs: () => 50 }).load('session_direct');
    expect(directView).toMatchObject({
      schemaVersion: 1,
      generatedAtMs: 50,
      cursor: { latestMessageRowId: 4 },
      timeline: {
        flat: [
          { type: 'message' },
          { type: 'tool_exchange', status: 'completed' },
          { type: 'message' },
        ],
        groupedByStep: [{ type: 'job_group', job: { id: 'job_direct' } }],
      },
    });
  });

  it('runs direct HITL through waiting, answer-as-tool-result, resume claim, and final completion', async () => {
    await store.createSession({ id: 'session_hitl', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_hitl', 'job_hitl', 'message_hitl', 20);
    const claimed = await store.claimJob({
      jobId: 'job_hitl',
      expectedVersion: 0,
      workerId: 'worker_hitl',
      attemptId: 'attempt_hitl_1',
      nowMs: 30,
      leaseUntilMs: 100,
    });
    const definition = {
      name: 'choose',
      description: 'choose a value',
      schema: { type: 'object' },
      sideEffectLevel: 'read_only' as const,
    };
    const toolExecutor = new ToolExecutor({
      store,
      workerId: 'worker_hitl',
      tools: [{
        definition,
        execute: async () => ({
          type: 'requires_user_input',
          request: {
            source: 'tool',
            answerMode: 'as_tool_result',
            prompt: 'Choose one',
            inputSchema: { type: 'single_choice', options: [{ label: 'One', value: 'one' }] },
          },
        }),
      }],
      clock: { nowMs: () => 35 },
    });
    let messageNo = 1;
    let writerNowMs = 36;
    const writer = new RuntimeEventWriter({
      store,
      workerId: 'worker_hitl',
      tools: [definition],
      ids: {
        eventId: () => 'event_hitl',
        messageId: () => `hitl_runtime_message_${messageNo++}`,
        toolInvocationId: () => 'hitl_invocation',
        userInputRequestId: () => 'hitl_input',
      },
      clock: { nowMs: () => writerNowMs },
    });
    const coordinator = new JobCoordinator({
      store,
      workerId: 'worker_hitl',
      clock: { nowMs: () => 40 },
      ids: {
        jobId: () => 'unused_job',
        messageId: () => 'hitl_answer_message',
        attemptId: () => 'attempt_hitl_2',
      },
    });
    const waitingRunner = new AgentRunner({
      loop: new AgentLoop({
        streaming: false,
        model: {
          invoke: async () => ({
            toolCalls: [{ id: 'call_hitl', name: 'choose', args: {} }],
          }),
        },
        clock: { nowMs: () => 35 },
      }),
      writer,
      coordinator,
    });
    const waiting = await waitingRunner.runDirect({
      job: claimed,
      messages: [],
      tools: [definition],
      toolExecutor,
      outputIdFactory: () => 'hitl_output_1',
      limits: { maxIterations: 2, maxToolCalls: 2, deadlineMs: 90 },
    });
    expect(waiting).toMatchObject({
      type: 'waiting_user_input',
      job: { status: 'waiting_user_input', version: 2 },
      requests: [{ id: 'hitl_input', status: 'pending', toolInvocationId: 'hitl_invocation' }],
    });
    if (waiting.type !== 'waiting_user_input') throw new Error('expected waiting result');

    const answered = await coordinator.answerInput({
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

    const resumeRunner = new AgentRunner({
      loop: new AgentLoop({
        streaming: false,
        model: { invoke: async () => ({ content: 'resumed final answer' }) },
        clock: { nowMs: () => 41 },
      }),
      writer,
      coordinator,
    });
    const resumed = await resumeRunner.runDirect({
      job: answered.job,
      messages: [],
      tools: [definition],
      toolExecutor,
      outputIdFactory: () => 'hitl_output_2',
      limits: { maxIterations: 2, maxToolCalls: 2, deadlineMs: 90 },
    });
    expect(resumed).toMatchObject({
      type: 'completed',
      job: { status: 'completed', version: 4 },
      message: { content: 'resumed final answer' },
    });
    expect((await store.listSessionMessages('session_hitl')).map(message => message.messageType))
      .toEqual(['user_message', 'tool_call', 'tool_result', 'assistant_message']);
  });

  it('advances a two-step Plan with explicit StepRun retry into plan_final completion', async () => {
    await store.createSession({ id: 'session_plan', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_plan', 'job_plan', 'message_plan_goal', 20);
    let job = await store.claimJob({
      jobId: 'job_plan',
      expectedVersion: 0,
      workerId: 'worker_plan',
      attemptId: 'attempt_plan',
      nowMs: 30,
      leaseUntilMs: 200,
    });
    job = await store.routeJob({
      jobId: job.id,
      workerId: 'worker_plan',
      attemptId: 'attempt_plan',
      strategy: 'planned',
      nowMs: 31,
    });
    expect(job).toMatchObject({ strategy: 'planned', stage: 'planning', version: 2 });
    const createdPlan = await store.createPlan({
      sessionId: 'session_plan',
      jobId: 'job_plan',
      workerId: 'worker_plan',
      attemptId: 'attempt_plan',
      planId: 'plan_work',
      messageId: 'message_plan_created',
      title: 'Two steps',
      goal: 'finish both',
      steps: [
        { id: 'step_one', title: 'One', instruction: 'do one' },
        { id: 'step_two', title: 'Two', instruction: 'do two' },
      ],
      nowMs: 32,
    });
    job = createdPlan.job;
    expect(job).toMatchObject({ stage: 'step_execution', version: 3 });

    let firstRun = await store.createStepRun({
      sessionId: 'session_plan', jobId: 'job_plan', workerId: 'worker_plan',
      attemptId: 'attempt_plan', planId: 'plan_work', stepId: 'step_one',
      stepRunId: 'run_one_1', executor: 'agent', maxRunsPerStep: 2, nowMs: 33,
    });
    expect(firstRun.stepRun).toMatchObject({ runNo: 1, status: 'running' });
    const firstOutput = await store.commitStepOutput({
      sessionId: 'session_plan', jobId: 'job_plan', workerId: 'worker_plan',
      attemptId: 'attempt_plan', stepRunId: 'run_one_1',
      messageId: 'message_step_one', outputId: 'output_step_one',
      content: 'step one complete', structuredOutput: { schemaVersion: 1, summary: 'one' }, nowMs: 34,
    });
    expect(firstOutput).toMatchObject({
      hasPendingSteps: true,
      step: { status: 'completed' },
      stepRun: { status: 'completed' },
      job: { stage: 'step_execution', version: 5 },
    });

    const secondRun = await store.createStepRun({
      sessionId: 'session_plan', jobId: 'job_plan', workerId: 'worker_plan',
      attemptId: 'attempt_plan', planId: 'plan_work', stepId: 'step_two',
      stepRunId: 'run_two_1', executor: 'agent', maxRunsPerStep: 2, nowMs: 35,
    });
    const failedForRetry = await store.failStepRun({
      sessionId: 'session_plan', jobId: 'job_plan', workerId: 'worker_plan',
      attemptId: 'attempt_plan', stepRunId: secondRun.stepRun.id,
      error: { code: 'invalid_step_output', message: 'repair failed' },
      retryStep: true, nowMs: 36,
    });
    expect(failedForRetry).toMatchObject({
      job: { status: 'running', stage: 'step_execution', version: 7 },
      step: { status: 'pending' },
      stepRun: { status: 'failed', runNo: 1 },
    });
    const retryRun = await store.createStepRun({
      sessionId: 'session_plan', jobId: 'job_plan', workerId: 'worker_plan',
      attemptId: 'attempt_plan', planId: 'plan_work', stepId: 'step_two',
      stepRunId: 'run_two_2', executor: 'agent', maxRunsPerStep: 2, nowMs: 37,
    });
    expect(retryRun.stepRun).toMatchObject({ runNo: 2, status: 'running' });
    const lastOutput = await store.commitStepOutput({
      sessionId: 'session_plan', jobId: 'job_plan', workerId: 'worker_plan',
      attemptId: 'attempt_plan', stepRunId: 'run_two_2',
      messageId: 'message_step_two', outputId: 'output_step_two',
      content: 'step two complete', structuredOutput: { schemaVersion: 1, summary: 'two' }, nowMs: 38,
    });
    expect(lastOutput).toMatchObject({
      hasPendingSteps: false,
      plan: { status: 'completed' },
      job: { stage: 'finalizing', version: 9 },
    });
    const final = await store.completeJobWithFinalMessage({
      sessionId: 'session_plan', jobId: 'job_plan', workerId: 'worker_plan',
      attemptId: 'attempt_plan', outputId: 'output_plan_final',
      messageId: 'message_plan_final', content: 'all steps complete',
      messageType: 'plan_final', nowMs: 39,
    });
    expect(final).toMatchObject({
      job: { status: 'completed', strategy: 'planned', stage: 'finalizing', version: 10 },
      message: { messageType: 'plan_final' },
    });
    expect((await store.listJobStepRuns('job_plan')).map(run => [run.id, run.runNo, run.status]))
      .toEqual([
        ['run_one_1', 1, 'completed'],
        ['run_two_1', 1, 'failed'],
        ['run_two_2', 2, 'completed'],
      ]);
    const planView = await new SessionView(store).load('session_plan');
    const planJobGroup = planView.timeline.groupedByStep[0];
    expect(planJobGroup.items.filter(item => item.type === 'step_group').map(item => (
      item.type === 'step_group' ? [item.step?.id, item.stepRun?.runNo, item.status] : []
    ))).toEqual([
      ['step_one', 1, 'completed'],
      ['step_two', 1, 'failed'],
      ['step_two', 2, 'completed'],
    ]);
  });

  it('repairs one invalid StepOutput, commits only validated JSON, and summarizes the Plan', async () => {
    await store.createSession({ id: 'session_step_runner', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_step_runner', 'job_step_runner', 'message_step_goal', 20);
    let job = await store.claimJob({
      jobId: 'job_step_runner', expectedVersion: 0, workerId: 'worker_step_runner',
      attemptId: 'attempt_step_runner', nowMs: 30, leaseUntilMs: 200,
    });
    job = await store.routeJob({
      jobId: job.id, workerId: 'worker_step_runner', attemptId: 'attempt_step_runner',
      strategy: 'planned', nowMs: 31,
    });
    const plan = await store.createPlan({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_step_runner',
      attemptId: 'attempt_step_runner', planId: 'plan_step_runner',
      messageId: 'message_step_plan', title: 'One step', goal: 'finish',
      steps: [{ id: 'step_runner_step', title: 'Step', instruction: 'Do it' }], nowMs: 32,
    });
    const started = await store.createStepRun({
      sessionId: job.sessionId, jobId: job.id, workerId: 'worker_step_runner',
      attemptId: 'attempt_step_runner', planId: plan.plan.id, stepId: plan.steps[0].id,
      stepRunId: 'run_step_runner', executor: 'agent', maxRunsPerStep: 2, nowMs: 33,
    });
    let writerMessageNo = 1;
    const writer = new RuntimeEventWriter({
      store,
      workerId: 'worker_step_runner',
      tools: [],
      ids: {
        eventId: () => 'step_event',
        messageId: () => `step_writer_message_${writerMessageNo++}`,
        toolInvocationId: () => 'unused_invocation',
        userInputRequestId: () => 'unused_input',
      },
      clock: { nowMs: () => 34 },
    });
    let repairCalls = 0;
    const runner = new StepRunner({
      loop: new AgentLoop({
        streaming: false,
        model: { invoke: async () => ({ content: 'not-json' }) },
        clock: { nowMs: () => 34 },
      }),
      writer,
      store,
      repair: {
        repair: async () => {
          repairCalls += 1;
          return {
            schemaVersion: 1,
            summary: 'validated after repair',
            artifacts: [],
            evidence: [],
            unresolved: [],
          };
        },
      },
    });
    const stepResult = await runner.run({
      job: started.job,
      stepRun: started.stepRun,
      messages: [],
      tools: [],
      toolExecutor: { execute: async () => { throw new Error('no tools expected'); } },
      outputIdFactory: () => 'output_repaired_step',
      limits: { maxIterations: 2, maxToolCalls: 2, deadlineMs: 100 },
    });
    expect(repairCalls).toBe(1);
    expect(stepResult).toMatchObject({
      type: 'completed',
      output: { schemaVersion: 1, summary: 'validated after repair' },
      job: { stage: 'finalizing' },
    });
    if (stepResult.type !== 'completed') throw new Error('expected completed step');
    const stepMessages = await store.listSessionMessages('session_step_runner');
    const committedOutput = stepMessages.find(message => message.messageType === 'step_output')!;
    expect(JSON.parse(committedOutput.content)).toMatchObject({
      schemaVersion: 1,
      summary: 'validated after repair',
    });
    expect(committedOutput.content).not.toContain('not-json');

    const summarize = vi.fn(async ({ outputs }) => `final:${outputs[0].output.summary}`);
    const engine = new PlanEngine({
      store,
      workerId: 'worker_step_runner',
      planner: {
        route: async () => 'planned',
        createPlan: async () => ({ title: 'unused', goal: 'unused', steps: [] }),
      },
      summarizer: new PlanSummarizer({ summarize }),
      ids: {
        planId: () => 'unused_plan', stepId: () => 'unused_step',
        stepRunId: () => 'unused_run', messageId: () => 'message_step_final',
        outputId: () => 'output_step_final',
      },
      clock: { nowMs: () => 35 },
    });
    const final = await engine.finalize(
      stepResult.job,
      'finish',
      '2026-07-11',
      'Asia/Shanghai'
    );
    expect(final).toMatchObject({
      job: { status: 'completed', stage: 'finalizing' },
      message: { messageType: 'plan_final', content: 'final:validated after repair' },
    });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('audits ModelCalls, accumulates usage, abandons orphaned calls, and replaces summaries', async () => {
    await store.createSession({ id: 'session_audit', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_audit', 'job_audit', 'message_audit', 20);
    const job = await store.claimJob({
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
      inputManifest: manifest, inputChecksum: 'checksum_1',
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
      inputManifest: manifest, inputChecksum: 'checksum_2',
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
    expect((await pool!.query(
      `select status from agent_context_summaries where id = 'summary_audit_1'`
    )).rows[0]).toEqual({ status: 'superseded' });
  });

  it('executes direct and two-step planned Jobs through the production runtime service', async () => {
    const now = Date.now();
    const events: AgentRealtimeEvent[] = [];
    const model: AgentLoopModelPort = {
      invoke: async request => {
        const text = request.messages.map(message => String(message.content)).join('\n');
        const usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20, source: 'provider' as const };
        if (text.includes('Return JSON only: {"strategy"')) {
          return { content: JSON.stringify({ strategy: text.includes('job_planned') ? 'planned' : 'direct' }), usage };
        }
        if (text.includes('Compress the supplied runtime history')) {
          return { content: 'compressed factual runtime history', usage };
        }
        if (text.includes('Keep steps declarative and ordered')) {
          return {
            content: JSON.stringify({
              title: 'Two step plan', goal: 'complete both steps',
              steps: [
                { title: 'First', instruction: 'Complete the first isolated step.' },
                { title: 'Second', instruction: 'Complete the second isolated step.' },
              ],
            }),
            usage,
          };
        }
        if (text.includes('Execute only the current PlanStep')) {
          return {
            content: JSON.stringify({
              schemaVersion: 1,
              summary: text.includes('second isolated') ? 'second complete' : 'first complete',
              artifacts: [], evidence: [], unresolved: [],
            }),
            usage,
          };
        }
        if (text.includes('Write the final user-facing answer')) {
          return { content: 'planned final answer', usage };
        }
        return { content: 'direct final answer', usage };
      },
    };
    const executor = new RuntimeJobExecutionService({
      store,
      workerId: 'worker_runtime_e2e',
      publisher: { publish: event => { events.push(event); } },
      model,
      provider: 'test',
      modelName: 'deterministic-model',
      tools: [],
      jobLeaseMs: 60_000,
      jobHeartbeatMs: 10_000,
      compressionMessageThreshold: 1,
    });

    await store.createSession({ id: 'session_runtime_e2e', mode: 'agent', nowMs: now });
    for (const id of ['job_direct', 'job_planned']) {
      await createJob(store, 'session_runtime_e2e', id, `message_${id}`, now + 1);
      const claimed = await store.claimJob({
        jobId: id, expectedVersion: 0, workerId: 'worker_runtime_e2e',
        attemptId: `attempt_${id}`, nowMs: now + 2, leaseUntilMs: now + 60_000,
      });
      expect(claimed.status).toBe('running');
      await executor.execute(id);
      expect(await store.getJob(id)).toMatchObject({ status: 'completed' });
    }

    const planned = await store.getPlanByJobId('job_planned');
    expect(planned).toMatchObject({ status: 'completed', title: 'Two step plan' });
    expect(await store.listPlanSteps(planned!.id)).toMatchObject([
      { status: 'completed', outputMessageId: expect.any(String) },
      { status: 'completed', outputMessageId: expect.any(String) },
    ]);
    expect(await store.listJobStepRuns('job_planned')).toMatchObject([
      { runNo: 1, status: 'completed' },
      { runNo: 1, status: 'completed' },
    ]);
    expect((await store.listSessionMessages('session_runtime_e2e')).at(-1)).toMatchObject({
      messageType: 'plan_final', content: 'planned final answer',
    });
    expect(await store.getModelUsageStats('session_runtime_e2e')).toMatchObject({
      totalModelCalls: 9,
      totalActualInputTokens: 108,
      totalActualOutputTokens: 72,
      totalTokens: 180,
    });
    expect((await store.listModelCalls('job_planned')).some(call => call.callType === 'context.compress')).toBe(true);
    expect(events.some(event => event.type === 'plan.upserted')).toBe(true);
    expect(events.some(event => event.type === 'step_run.upserted')).toBe(true);
    expect(events.some(event => event.type === 'model_usage.updated')).toBe(true);
  });

  it('fails descendants atomically, preserves side-effect uncertainty, and creates retry as a new Job', async () => {
    await store.createSession({ id: 'session_fail', mode: 'agent', nowMs: 10 });
    await createJob(store, 'session_fail', 'job_fail', 'message_fail', 20);
    const claimed = await store.claimJob({
      jobId: 'job_fail',
      expectedVersion: 0,
      workerId: 'worker_fail',
      attemptId: 'attempt_fail',
      nowMs: 30,
      leaseUntilMs: 100,
    });
    await seedRunningDescendants(pool!, claimed.currentAttemptId!);

    const failed = await store.failJob({
      jobId: claimed.id,
      expectedVersion: claimed.version,
      workerId: claimed.leaseOwner!,
      attemptId: claimed.currentAttemptId!,
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
         (select status from agent_step_runs where id = 'run_fail') as run_status,
         (select status from agent_tool_invocations where id = 'invocation_side') as side_status,
         (select error_code from agent_tool_invocations where id = 'invocation_side') as side_error_code,
         (select status from agent_tool_invocations where id = 'invocation_read') as read_status,
         (select status from agent_user_input_requests where id = 'input_fail') as input_status`
    );
    expect(descendantStates.rows[0]).toEqual({
      plan_status: 'failed',
      step_status: 'failed',
      run_status: 'failed',
      side_status: 'unknown',
      side_error_code: 'side_effect_status_unknown',
      read_status: 'cancelled',
      input_status: 'cancelled',
    });

    const retry = await store.createJobAndAppendUserMessage({
      sessionId: 'session_fail',
      jobId: 'job_retry',
      retryOfJobId: 'job_fail',
      userMessageId: 'message_retry',
      content: 'retry',
      nowMs: 50,
    });
    expect(retry.job).toMatchObject({
      id: 'job_retry',
      retryOfJobId: 'job_fail',
      status: 'created',
    });
  });

  it('cancels a created Job without requiring a lease', async () => {
    await store.createSession({ id: 'session_cancel', mode: 'agent', nowMs: 10 });
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
});

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
         id, plan_id, position, title, instruction, status, version, created_at_ms, updated_at_ms
       ) values ('step_fail', 'plan_fail', 0, 'Step', 'Do it', 'running', 0, 32, 32)`
    );
    await client.query(
      `insert into agent_step_runs(
         id, session_id, job_id, plan_id, step_id, run_no, executor, status,
         current_attempt_id, attempt_no, version, created_at_ms, updated_at_ms, started_at_ms
       ) values (
         'run_fail', 'session_fail', 'job_fail', 'plan_fail', 'step_fail', 1,
         'agent', 'running', $1, 1, 0, 33, 33, 33
       )`,
      [attemptId]
    );
    await client.query(
      `insert into agent_messages(
         id, session_id, job_id, plan_id, step_id, step_run_id, attempt_id,
         role, message_type, visibility, channel, content, tool_calls, created_at_ms
       ) values (
         'tool_calls_fail', 'session_fail', 'job_fail', 'plan_fail', 'step_fail', 'run_fail', $1,
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
         id, session_id, job_id, plan_id, step_id, step_run_id,
         source, answer_mode, status, prompt, input_schema,
         version, created_at_ms, updated_at_ms
       ) values (
         'input_fail', 'session_fail', 'job_fail', 'plan_fail', 'step_fail', 'run_fail',
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
       id, session_id, job_id, plan_id, step_id, step_run_id, attempt_id,
       call_message_id, tool_call_id, tool_name, arguments, arguments_checksum,
       side_effect_level, idempotency_key, status, version,
       created_at_ms, started_at_ms, updated_at_ms
     ) values (
       $1, 'session_fail', 'job_fail', 'plan_fail', 'step_fail', 'run_fail', $2,
       'tool_calls_fail', $3, $4, '{}'::jsonb, $1,
       $5, $1, 'running', 0,
       35, 35, 35
     )`,
    [invocation.id, attemptId, invocation.toolCallId, invocation.tool, invocation.sideEffect]
  );
}
