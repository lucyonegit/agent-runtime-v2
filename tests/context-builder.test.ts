import { describe, expect, it } from 'vitest';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type {
  AgentJob,
  AgentMessage,
  AgentStepRun,
  AgentToolInvocation,
} from '../src/domain/index.js';
import {
  ContextBuilder,
  IncompleteMessageGroupError,
} from '../src/context/context-builder.js';
import { ContextFilter } from '../src/context/context-filter.js';
import { MessageGroupBuilder } from '../src/context/message-group-builder.js';
import { ContextOverflowError, TokenBudget } from '../src/context/token-budget.js';

describe('MessageGroupBuilder', () => {
  it('builds a complete multi-tool exchange in model call order', () => {
    const call = toolCallMessage('call_message', 'run_current', [
      { id: 'call_a', name: 'a', args: {} },
      { id: 'call_b', name: 'b', args: {} },
    ]);
    const resultA = toolResultMessage('result_a', 3, 'call_a', 'a');
    const resultB = toolResultMessage('result_b', 4, 'call_b', 'b');
    const builder = new MessageGroupBuilder();

    const built = builder.build(
      [goalMessage, call, resultB, resultA],
      [
        invocation('invocation_b', call, resultB, 'call_b', 'b', 'completed'),
        invocation('invocation_a', call, resultA, 'call_a', 'a', 'completed'),
      ]
    );

    expect(built.blocked).toEqual([]);
    expect(built.groups[1]).toMatchObject({
      type: 'tool_exchange',
      resultMessages: [{ id: 'result_a' }, { id: 'result_b' }],
      invocations: [{ toolCallId: 'call_a' }, { toolCallId: 'call_b' }],
    });
  });

  it('blocks the whole exchange while any invocation is non-terminal', () => {
    const call = toolCallMessage('call_waiting', 'run_current', [
      { id: 'call_wait', name: 'wait', args: {} },
    ]);
    const built = new MessageGroupBuilder().build(
      [call],
      [invocation('invocation_wait', call, undefined, 'call_wait', 'wait', 'waiting_user_input')]
    );

    expect(built.groups).toEqual([]);
    expect(built.blocked).toMatchObject([{
      callMessage: { id: 'call_waiting' },
      reason: 'invocation_not_terminal',
      toolCallId: 'call_wait',
    }]);
  });
});

describe('ContextFilter', () => {
  it('keeps previous StepOutput and current StepRun tail but excludes other StepRun raw runtime', () => {
    const previousOutput = message({
      id: 'step_output_previous',
      rowId: 2,
      messageType: 'step_output',
      role: 'assistant',
      stepRunId: 'run_previous',
      content: 'validated previous output',
    });
    const current = message({
      id: 'current_runtime',
      rowId: 3,
      messageType: 'assistant_message',
      role: 'assistant',
      stepRunId: 'run_current',
      content: 'current runtime',
    });
    const other = message({
      id: 'other_runtime',
      rowId: 4,
      messageType: 'assistant_message',
      role: 'assistant',
      stepRunId: 'run_other',
      content: 'must not leak',
    });
    const groups = new MessageGroupBuilder().build(
      [goalMessage, previousOutput, current, other],
      []
    ).groups;

    const filtered = new ContextFilter().filter(groups, {
      purpose: 'step_execution',
      currentJobId: 'job_1',
      currentStepRunId: 'run_current',
    });
    expect(filtered.map(group => group.id)).toEqual([
      'message:goal',
      'step_output:step_output_previous',
      'message:current_runtime',
    ]);
  });

  it('allows plan_final to read only the original goal and validated StepOutput', () => {
    const raw = message({
      id: 'raw_runtime',
      rowId: 2,
      messageType: 'assistant_message',
      role: 'assistant',
      stepRunId: 'run_current',
      content: 'raw search details',
    });
    const output = message({
      id: 'step_output',
      rowId: 3,
      messageType: 'step_output',
      role: 'assistant',
      content: 'validated',
    });
    const groups = new MessageGroupBuilder().build([goalMessage, raw, output], []).groups;

    expect(new ContextFilter().filter(groups, {
      purpose: 'plan_final',
      currentJobId: 'job_1',
    }).map(group => group.id)).toEqual(['message:goal', 'step_output:step_output']);
  });
});

describe('TokenBudget', () => {
  it('never drops mustKeep items and rejects mustKeep overflow', () => {
    const budget = new TokenBudget();
    expect(() => budget.select([{
      id: 'system',
      value: 'system',
      estimatedTokens: 91,
      mustKeep: true,
      priority: 1,
      recency: 1,
      originalOrder: 0,
    }], { maxContextTokens: 100, reservedOutputTokens: 10 }))
      .toThrow(ContextOverflowError);

    const selection = budget.select([
      {
        id: 'must_keep', value: 'must_keep', estimatedTokens: 20,
        mustKeep: true, priority: 100, recency: 0, originalOrder: 0,
      },
      {
        id: 'whole_tool_exchange', value: 'tool', estimatedTokens: 70,
        mustKeep: false, priority: 90, recency: 2, originalOrder: 1,
      },
      {
        id: 'small_recent', value: 'small', estimatedTokens: 10,
        mustKeep: false, priority: 80, recency: 3, originalOrder: 2,
      },
    ], { maxContextTokens: 100, reservedOutputTokens: 10 });
    expect(selection.selected.map(item => item.id)).toEqual(['must_keep', 'small_recent']);
    expect(selection.dropped.map(item => item.id)).toEqual(['whole_tool_exchange']);
  });
});

describe('ContextBuilder', () => {
  it('formats complete tool protocol and emits an auditable manifest', () => {
    const call = toolCallMessage('call_context', 'run_current', [
      { id: 'call_lookup', name: 'lookup', args: { q: 'docs' } },
    ]);
    const result = toolResultMessage('result_context', 3, 'call_lookup', 'lookup');
    const context = new ContextBuilder().build({
      job: jobFixture,
      stepRun: stepRunFixture,
      attemptId: 'attempt_1',
      purpose: 'step_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'system-v1',
      originalGoal: 'goal',
      currentInstruction: 'do step',
      messages: [goalMessage, call, result],
      invocations: [
        invocation('invocation_context', call, result, 'call_lookup', 'lookup', 'completed'),
      ],
      summaries: [{ id: 'summary_1', summary: 'stable summary' }],
      model: {
        provider: 'test',
        name: 'test-model',
        maxContextTokens: 2_000,
        reservedOutputTokens: 200,
      },
      toolSchemas: [new DynamicStructuredTool({
        name: 'lookup',
        description: 'lookup',
        schema: { type: 'object', additionalProperties: true } as const,
        func: async input => input,
      })],
    });

    expect(context.messages.map(message_ => message_.content)).toEqual([
      'system',
      'do step',
      'Context summary:\nstable summary',
      'goal',
      '',
      'result:lookup',
    ]);
    expect(context.inputManifest).toMatchObject({
      purpose: 'step_execution',
      contextRulesVersion: 'job-step-run-context-v2',
      systemPromptVersion: 'system-v1',
      messageGroupIds: ['message:goal', 'tool_exchange:call_context'],
      summaryIds: ['summary_1'],
      includedRowIdStart: 1,
      includedRowIdEnd: 3,
      toolSchemaChecksum: expect.any(String),
      fixedPrefixChecksum: expect.any(String),
    });
  });

  it('refuses to build current execution context from an incomplete tool exchange', () => {
    const call = toolCallMessage('call_incomplete', 'run_current', [
      { id: 'call_wait', name: 'wait', args: {} },
    ]);
    expect(() => new ContextBuilder().build({
      job: jobFixture,
      stepRun: stepRunFixture,
      attemptId: 'attempt_1',
      purpose: 'step_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'v1',
      originalGoal: 'goal',
      currentInstruction: 'step',
      messages: [goalMessage, call],
      invocations: [
        invocation('invocation_wait', call, undefined, 'call_wait', 'wait', 'running'),
      ],
      model: { provider: 'test', name: 'model', maxContextTokens: 1000, reservedOutputTokens: 100 },
    })).toThrow(IncompleteMessageGroupError);
  });

  it('uses an active summary instead of re-including covered message groups', () => {
    const old = message({
      id: 'old_assistant', rowId: 2, role: 'assistant',
      messageType: 'assistant_message', content: 'covered history',
    });
    const recent = message({
      id: 'recent_assistant', rowId: 3, role: 'assistant',
      messageType: 'assistant_message', content: 'recent tail',
    });
    const context = new ContextBuilder().build({
      job: jobFixture,
      attemptId: 'attempt_1',
      purpose: 'job_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'v1',
      originalGoal: 'goal',
      messages: [goalMessage, old, recent],
      invocations: [],
      summaries: [{ id: 'summary_covered', summary: 'compressed history', sourceRowIdEnd: 2 }],
      model: { provider: 'test', name: 'model', maxContextTokens: 1000, reservedOutputTokens: 100 },
    });

    expect(context.messages.map(item => item.content)).toEqual([
      'system', 'Context summary:\ncompressed history', 'goal', 'recent tail',
    ]);
    expect(context.inputManifest.messageGroupIds).toEqual([
      'message:goal',
      'message:recent_assistant',
    ]);
  });

  it('keeps cross-Job conversation in row order with the current user message last', () => {
    const previousUser = message({
      id: 'previous_user', rowId: 10, jobId: 'job_previous',
      content: '你有哪些工具？',
    });
    const previousAssistant = message({
      id: 'previous_assistant', rowId: 11, jobId: 'job_previous',
      role: 'assistant', messageType: 'assistant_message', content: '工具列表',
    });
    const currentUser = message({
      id: 'current_user', rowId: 12, content: '现在几点了？',
    });
    const context = new ContextBuilder().build({
      job: jobFixture,
      attemptId: 'attempt_1',
      purpose: 'job_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'v1',
      originalGoal: '现在几点了？',
      messages: [currentUser, previousAssistant, previousUser],
      invocations: [],
      model: { provider: 'test', name: 'model', maxContextTokens: 1000, reservedOutputTokens: 100 },
    });

    expect(context.messages.map(item => item.content)).toEqual([
      'system',
      '你有哪些工具？',
      '工具列表',
      '现在几点了？',
    ]);
    expect(context.inputManifest.messageGroupIds).toEqual([
      'message:previous_user',
      'message:previous_assistant',
      'message:current_user',
    ]);
    expect(context.mustKeepMessageIds).toEqual(['current_user']);
    expect(context.compressibleMessageIds).toEqual([
      'previous_user',
      'previous_assistant',
    ]);
  });

  it('keeps the current user message even when a summary covers its row', () => {
    const previousUser = message({
      id: 'previous_user', rowId: 20, jobId: 'job_previous', content: '旧问题',
    });
    const currentUser = message({
      id: 'current_user', rowId: 21, content: '当前问题',
    });
    const context = new ContextBuilder().build({
      job: jobFixture,
      attemptId: 'attempt_1',
      purpose: 'job_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'v1',
      originalGoal: '当前问题',
      messages: [previousUser, currentUser],
      invocations: [],
      summaries: [{
        id: 'summary_covering_current',
        summary: '压缩后的历史',
        sourceRowIdEnd: currentUser.rowId,
      }],
      model: { provider: 'test', name: 'model', maxContextTokens: 1000, reservedOutputTokens: 100 },
    });

    expect(context.messages.map(item => item.content)).toEqual([
      'system',
      'Context summary:\n压缩后的历史',
      '当前问题',
    ]);
    expect(context.inputManifest.messageGroupIds).toEqual(['message:current_user']);
    expect(context.mustKeepMessageIds).toEqual(['current_user']);
    expect(context.compressibleMessageIds).toEqual([]);
  });
});

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'id'>): AgentMessage {
  return {
    rowId: 1,
    sessionId: 'session_1',
    jobId: 'job_1',
    role: 'user',
    messageType: 'user_message',
    visibility: 'ui',
    channel: 'normal',
    content: 'goal',
    createdAtMs: 1,
    ...overrides,
  };
}

function toolCallMessage(
  id: string,
  stepRunId: string,
  toolCalls: NonNullable<AgentMessage['toolCalls']>
): AgentMessage {
  return message({
    id,
    rowId: 2,
    role: 'assistant',
    messageType: 'tool_call',
    content: '',
    stepRunId,
    toolCalls,
  });
}

function toolResultMessage(
  id: string,
  rowId: number,
  toolCallId: string,
  toolName: string
): AgentMessage {
  return message({
    id,
    rowId,
    role: 'tool',
    messageType: 'tool_result',
    stepRunId: 'run_current',
    content: `result:${toolName}`,
    toolCallId,
    toolName,
    toolResult: { status: 'completed', result: { ok: true } },
  });
}

function invocation(
  id: string,
  callMessage: AgentMessage,
  resultMessage: AgentMessage | undefined,
  toolCallId: string,
  toolName: string,
  status: AgentToolInvocation['status']
): AgentToolInvocation {
  return {
    id,
    sessionId: 'session_1',
    jobId: 'job_1',
    stepRunId: callMessage.stepRunId,
    attemptId: 'attempt_1',
    callMessageId: callMessage.id,
    resultMessageId: resultMessage?.id,
    toolCallId,
    toolName,
    arguments: {},
    argumentsChecksum: 'checksum',
    sideEffectLevel: 'read_only',
    idempotencyKey: id,
    status,
    version: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

const goalMessage = message({ id: 'goal', content: 'goal' });

const jobFixture: AgentJob = {
  id: 'job_1',
  sessionId: 'session_1',
  strategy: 'planned',
  stage: 'step_execution',
  status: 'running',
  currentAttemptId: 'attempt_1',
  attemptNo: 1,
  leaseOwner: 'worker_1',
  leaseExpiresAtMs: 100,
  version: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
};

const stepRunFixture: AgentStepRun = {
  id: 'run_current',
  sessionId: 'session_1',
  jobId: 'job_1',
  planId: 'plan_1',
  stepId: 'step_1',
  runNo: 1,
  status: 'running',
  currentAttemptId: 'attempt_1',
  attemptNo: 1,
  version: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
};
