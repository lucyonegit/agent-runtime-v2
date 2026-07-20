import { describe, expect, it } from 'vitest';
import { SystemMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type {
  AgentMessage,
  AgentToolInvocation,
} from '../src/domain/index.js';
import {
  compileContext,
  CONTEXT_RULES_VERSION,
} from '../src/runtime/context/context-compiler.js';
import type { ContextMaterial } from '../src/runtime/context/context-material.js';
import { MessageGroupBuilder, messagesInGroup } from '../src/runtime/context/message-group-builder.js';
import { ContextOverflowError, TokenBudget } from '../src/runtime/context/token-budget.js';
import { IncompleteMessageGroupError } from '../src/runtime/loaders/session-context-loader.js';

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

describe('ContextCompiler', () => {
  it('formats complete tool protocol and emits an auditable manifest', () => {
    const call = toolCallMessage('call_context', 'run_current', [
      { id: 'call_lookup', name: 'lookup', args: { q: 'docs' } },
    ]);
    const result = toolResultMessage('result_context', 3, 'call_lookup', 'lookup');
    const context = buildContext({
      scope: { kind: 'job', jobId: 'job_1', originalGoal: 'goal' },
      purpose: 'job_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'system-v1',
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
      purpose: 'job_execution',
      contextRulesVersion: CONTEXT_RULES_VERSION,
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
    expect(() => buildContext({
      scope: { kind: 'job', jobId: 'job_1', originalGoal: 'goal' },
      purpose: 'job_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'v1',
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
    const context = buildContext({
      scope: { kind: 'job', jobId: 'job_1', originalGoal: 'goal' },
      purpose: 'job_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'v1',
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
    const context = buildContext({
      scope: { kind: 'job', jobId: 'job_1', originalGoal: '现在几点了？' },
      purpose: 'job_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'v1',
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

  it('reuses the failed Job goal once as the retry Job must-keep message', () => {
    const sourceGoal = message({
      id: 'source_goal', rowId: 10, jobId: 'job_failed', content: '我想抽个塔罗',
    });
    const failedAssistant = message({
      id: 'failed_assistant', rowId: 11, jobId: 'job_failed', role: 'assistant',
      messageType: 'assistant_message', content: '需要重试',
    });
    const context = buildContext({
      scope: {
        kind: 'job',
        jobId: 'job_retry',
        originalGoal: '我想抽个塔罗',
        originalGoalMessageId: 'source_goal',
      },
      purpose: 'job_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'v1',
      messages: [sourceGoal, failedAssistant],
      invocations: [],
      summaries: [{ id: 'summary_failed', summary: '失败尝试摘要', sourceRowIdEnd: 11 }],
      model: { provider: 'test', name: 'model', maxContextTokens: 1000, reservedOutputTokens: 100 },
    });

    expect(context.messages.map(item => item.content)).toEqual([
      'system',
      'Context summary:\n失败尝试摘要',
      '我想抽个塔罗',
    ]);
    expect(context.mustKeepMessageIds).toEqual(['source_goal']);
    expect(context.inputManifest.messageGroupIds).toEqual(['message:source_goal']);
  });

  it('builds complete Session history deterministically without mutating its input', () => {
    const previousUser = message({
      id: 'previous_user', rowId: 10, jobId: 'job_previous', content: '调查并生成报告',
    });
    const planningNote = message({
      id: 'planning_note', rowId: 11, jobId: 'job_previous', role: 'assistant',
      messageType: 'assistant_message', content: '调查计划',
    });
    const previousCall = {
      ...toolCallMessage('previous_call', 'run_previous', [
        { id: 'call_search', name: 'web_search', args: { query: 'news' } },
      ]),
      rowId: 12,
      jobId: 'job_previous',
    };
    const previousResult = {
      ...toolResultMessage('previous_result', 13, 'call_search', 'web_search'),
      jobId: 'job_previous',
    };
    const previousOutput = message({
      id: 'previous_output', rowId: 14, jobId: 'job_previous', role: 'assistant',
      messageType: 'assistant_message', content: 'structured step output',
    });
    const finalAnswer = message({
      id: 'final_answer', rowId: 15, jobId: 'job_previous', role: 'assistant',
      messageType: 'assistant_message', channel: 'final', content: '最终报告',
    });
    const previousInvocation = {
      ...invocation(
        'previous_invocation', previousCall, previousResult,
        'call_search', 'web_search', 'completed'
      ),
      jobId: 'job_previous',
    };

    const messages = [
      previousOutput, previousResult, finalAnswer,
      previousCall, planningNote, previousUser,
    ];
    const messagesBeforeBuild = structuredClone(messages);
    const input = {
      scope: { kind: 'session_history' as const },
      purpose: 'job_execution' as const,
      systemPrompt: 'system',
      systemPromptVersion: 'v1',
      messages,
      invocations: [previousInvocation],
      model: { provider: 'test', name: 'model', maxContextTokens: 4_000, reservedOutputTokens: 200 },
    };
    const context = buildContext(input);
    const rebuilt = buildContext(input);

    expect(context.inputManifest.messageGroupIds).toEqual([
      'message:previous_user',
      'message:planning_note',
      'tool_exchange:previous_call',
      'message:previous_output',
      'message:final_answer',
    ]);
    expect(context.messages.map(item => item.content)).toEqual([
      'system',
      '调查并生成报告',
      '调查计划',
      '',
      'result:web_search',
      'structured step output',
      '最终报告',
    ]);
    expect(context.mustKeepMessageIds).toEqual([]);
    expect(context.compressibleMessageIds).toEqual([
      'previous_user',
      'planning_note',
      'previous_call',
      'previous_result',
      'previous_output',
      'final_answer',
    ]);
    expect(rebuilt.inputManifest).toEqual(context.inputManifest);
    expect(rebuilt.messages.map(item => item.toDict())).toEqual(
      context.messages.map(item => item.toDict())
    );
    expect(messages).toEqual(messagesBeforeBuild);
  });

  it('keeps the current user message even when a summary covers its row', () => {
    const previousUser = message({
      id: 'previous_user', rowId: 20, jobId: 'job_previous', content: '旧问题',
    });
    const currentUser = message({
      id: 'current_user', rowId: 21, content: '当前问题',
    });
    const context = buildContext({
      scope: { kind: 'job', jobId: 'job_1', originalGoal: '当前问题' },
      purpose: 'job_execution',
      systemPrompt: 'system',
      systemPromptVersion: 'v1',
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

interface CompilerFixtureInput {
  scope:
    | { kind: 'session_history' }
    | { kind: 'job'; jobId: string; originalGoal: string; originalGoalMessageId?: string };
  purpose: string;
  systemPrompt: string;
  systemPromptVersion: string;
  currentInstruction?: string;
  messages: AgentMessage[];
  invocations: AgentToolInvocation[];
  summaries?: ContextMaterial['summaries'];
  model: ContextMaterial['model'];
  toolSchemas?: StructuredToolInterface[];
}

function buildContext(input: CompilerFixtureInput) {
  const built = new MessageGroupBuilder().build(input.messages, input.invocations);
  if (built.blocked.length > 0) {
    const blocked = built.blocked[0]!;
    throw new IncompleteMessageGroupError(
      `Tool exchange ${JSON.stringify(blocked.callMessage.id)} is incomplete: ${blocked.reason}.`
    );
  }
  const fixedMessages = [{
    id: 'must_keep:system',
    message: new SystemMessage(input.systemPrompt),
    text: input.systemPrompt,
  }];
  if (input.currentInstruction) {
    fixedMessages.push({
      id: 'must_keep:instruction',
      message: new SystemMessage(input.currentInstruction),
      text: input.currentInstruction,
    });
  }
  const executionScope = input.scope.kind === 'session_history' ? undefined : input.scope;
  return compileContext({
    fixedMessages,
    fixedPrefix: {
      systemPrompt: input.systemPrompt,
      currentInstruction: input.currentInstruction,
    },
    groups: built.groups.map(group => {
      const messages = messagesInGroup(group);
      const mustKeep = executionScope !== undefined && (
        executionScope.originalGoalMessageId
          ? messages.some(item => item.id === executionScope.originalGoalMessageId)
          : messages.some(item => (
              item.jobId === executionScope.jobId
              && item.messageType === 'user_message'
              && item.content === executionScope.originalGoal
            ))
      );
      return {
        group,
        segment: input.scope.kind === 'session_history'
          ? 'session_history' as const
          : messages.some(item => item.jobId === executionScope!.jobId)
            ? 'current_job' as const
            : 'session_history' as const,
        mustKeep,
        priority: mustKeep ? 1_000 : 40,
      };
    }),
    summaries: input.summaries ?? [],
    toolSchemas: input.toolSchemas ?? [],
    model: input.model,
    audit: {
      purpose: input.purpose,
      contextRulesVersion: CONTEXT_RULES_VERSION,
      systemPromptVersion: input.systemPromptVersion,
    },
    compression: {
      disabled: false,
      newCompressibleMessageCount: 0,
      messageThreshold: 50,
    },
  });
}

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
  _scopeId: string,
  toolCalls: NonNullable<AgentMessage['toolCalls']>
): AgentMessage {
  return message({
    id,
    rowId: 2,
    role: 'assistant',
    messageType: 'tool_call',
    content: '',
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
