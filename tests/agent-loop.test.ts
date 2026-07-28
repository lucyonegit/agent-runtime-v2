import { describe, expect, it, vi } from 'vitest';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Runnable, type RunnableConfig } from '@langchain/core/runnables';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import {
  AgentLoop as RuntimeAgentLoop,
  type AgentLoopInput,
  type AgentLoopOptions,
  type AgentLoopResumeState,
  type ToolExecutorPort,
} from '../src/runtime/loop/agent-loop.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../src/runtime/loop/loop-events.js';
import type { LoopResult } from '../src/runtime/loop/loop-result.js';

class AgentLoop extends RuntimeAgentLoop {
  constructor(
    options: Omit<AgentLoopOptions, 'createOutputId'> & {
      createOutputId?: () => string;
    }
  ) {
    let outputNo = 0;
    super({
      ...options,
      createOutputId: options.createOutputId ?? (() => `output_${++outputNo}`),
    });
  }
}

describe('AgentLoop with LangChain messages', () => {
  it('streams AIMessageChunks and returns an explicit completed result', async () => {
    const loop = new AgentLoop({
      model: streamingModel(async function* () {
        yield chunk('hel');
        yield new AIMessageChunk({
          content: 'lo',
          usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        });
      }),
    });
    const run = await consume(loop.run(loopInput()));

    expect(run.events).toMatchObject([
      { type: 'model.output.delta', outputId: 'output_1', channel: 'normal', delta: 'hel' },
      { type: 'model.output.delta', outputId: 'output_1', channel: 'normal', delta: 'lo' },
      {
        type: 'model.output.completed', outputId: 'output_1', content: 'hello', toolCalls: [],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
    ]);
    expect(run.result).toEqual({ type: 'completed', outputId: 'output_1', content: 'hello' });
  });

  it('discards output stopped by the configured token limit', async () => {
    const loop = new AgentLoop({
      model: streamingModel(async function* () {
        yield chunk('partial answer');
        yield new AIMessageChunk({
          content: '',
          response_metadata: { finish_reason: 'length' },
        });
      }),
    });

    const run = await consume(loop.run(loopInput()));

    expect(run.events).toEqual([
      {
        type: LOOP_EVENT_TYPES.ModelOutputDelta,
        outputId: 'output_1',
        channel: 'normal',
        delta: 'partial answer',
      },
      {
        type: LOOP_EVENT_TYPES.ModelOutputRejected,
        outputId: 'output_1',
        reason: 'Model output reached its configured token limit and was discarded.',
      },
    ]);
    expect(run.result).toEqual({
      type: 'failed',
      code: 'model_output_truncated',
      message: 'Model output reached its configured token limit and was discarded.',
      details: { outputTokenLimitReached: true },
    });
  });

  it('corrects a mixed exclusive-tool batch without failing the Task', async () => {
    let calls = 0;
    const execute = vi.fn<ToolExecutorPort['execute']>(async ({ call }) => ({
      type: 'completed', content: `${call.name}:done`,
    }));
    const loop = new AgentLoop({
      streaming: false,
      model: invokeModel(() => {
        calls += 1;
        if (calls === 1) {
          return toolChunk([
            { id: 'call_plan_bad', name: 'update_plan', args: {} },
            { id: 'call_lookup_bad', name: 'lookup', args: {} },
          ]);
        }
        if (calls === 2) {
          return toolChunk([{ id: 'call_plan_ok', name: 'update_plan', args: {} }]);
        }
        return chunk('finished');
      }),
    });

    const run = await consume(loop.run(loopInput({
      tools: {
        definitions: [toolDefinition('lookup'), toolDefinition('update_plan')],
        exclusiveNames: new Set(['update_plan']),
        executor: { execute },
      },
    })));

    expect(run.events.map(event => event.type)).toEqual([
      LOOP_EVENT_TYPES.ModelOutputRejected,
      LOOP_EVENT_TYPES.ModelOutputCompleted,
      LOOP_EVENT_TYPES.ToolResultCompleted,
      LOOP_EVENT_TYPES.ModelOutputCompleted,
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].call.id).toBe('call_plan_ok');
    expect(run.result).toMatchObject({ type: 'completed', content: 'finished' });
  });

  it('rejects dependency-sensitive sibling tool calls before persisting or executing them', async () => {
    let calls = 0;
    const execute = vi.fn<ToolExecutorPort['execute']>(async ({ call }) => ({
      type: 'completed', content: `${call.name}:done`,
    }));
    const loop = new AgentLoop({
      streaming: false,
      model: invokeModel(() => {
        calls += 1;
        if (calls === 1) {
          return toolChunk([
            { id: 'call_search_bad', name: 'web_search', args: { query: 'topic' } },
            { id: 'call_write_bad', name: 'write_article', args: { title: 'report' } },
          ]);
        }
        if (calls === 2) {
          return toolChunk([{ id: 'call_search_ok', name: 'web_search', args: { query: 'topic' } }]);
        }
        return chunk('finished');
      }),
    });
    const validateToolCalls = vi.fn<
      NonNullable<NonNullable<AgentLoopInput['policy']>['validateToolCalls']>
    >(async ({ toolCalls }) => (
      toolCalls.some(call => call.name === 'write_article') && toolCalls.length > 1
        ? { type: 'retry' as const, feedback: 'Search first, then write in a later turn.' }
        : { type: 'accept' as const }
    ));

    const run = await consume(loop.run(loopInput({
      tools: {
        definitions: [toolDefinition('web_search'), toolDefinition('write_article')],
        executor: { execute },
      },
      policy: { validateToolCalls },
    })));

    expect(run.events.map(event => event.type)).toEqual([
      LOOP_EVENT_TYPES.ModelOutputRejected,
      LOOP_EVENT_TYPES.ModelOutputCompleted,
      LOOP_EVENT_TYPES.ToolResultCompleted,
      LOOP_EVENT_TYPES.ModelOutputCompleted,
    ]);
    expect(run.events[0]).toMatchObject({ reason: 'Search first, then write in a later turn.' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].call.id).toBe('call_search_ok');
  });

  it('does not execute a tool until its AIMessage event has been consumed', async () => {
    let calls = 0;
    const execute = vi.fn<ToolExecutorPort['execute']>(async () => ({
      type: 'completed', content: 'tool result',
    }));
    const loop = new AgentLoop({
      streaming: false,
      model: invokeModel(() => ++calls === 1
        ? toolChunk([{ id: 'call_1', name: 'lookup', args: { q: 'docs' } }])
        : chunk('done')),
    });
    const iterator = loop.run(loopInput({ tools: { executor: { execute } } }));

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: LOOP_EVENT_TYPES.ModelOutputCompleted, toolCalls: [{ id: 'call_1' }] },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: LOOP_EVENT_TYPES.ToolResultCompleted, modelToolCallId: 'call_1' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await iterator.next();
    expect(await iterator.next()).toEqual({
      done: true,
      value: { type: 'completed', outputId: 'output_2', content: 'done' },
    });
  });

  it('waits for each sibling result before executing the next tool', async () => {
    const executed: string[] = [];
    let calls = 0;
    const loop = new AgentLoop({
      streaming: false,
      model: invokeModel(() => ++calls === 1
        ? toolChunk([
            { id: 'call_1', name: 'one', args: {} },
            { id: 'call_2', name: 'two', args: {} },
          ])
        : chunk('done')),
    });
    const iterator = loop.run(loopInput({
      tools: {
        executor: {
          execute: async ({ call }) => {
            executed.push(call.id);
            return { type: 'completed', content: call.id };
          },
        },
      },
    }));

    await iterator.next();
    expect(executed).toEqual([]);
    await iterator.next();
    expect(executed).toEqual(['call_1']);
    await iterator.next();
    expect(executed).toEqual(['call_1', 'call_2']);
  });

  it('resumes pending checkpoint tools before making the next model call', async () => {
    const order: string[] = [];
    const loop = new AgentLoop({
      streaming: false,
      model: invokeModel(() => {
        order.push('model');
        return chunk('continued from checkpoint');
      }),
    });
    const run = await consume(loop.run(loopInput({
      resume: {
        iterationNo: 3,
        executedToolCalls: 4,
        pendingToolCalls: [{
          id: 'call_resume_5',
          name: 'lookup',
          args: { q: 'checkpoint' },
        }],
      },
      context: {
        loadMessages: async iteration => {
          order.push(`context:${iteration}`);
          return [];
        },
      },
      tools: {
        executor: {
          execute: async ({ call }) => {
            order.push(`tool:${call.id}`);
            return { type: 'completed', content: 'recovered result' };
          },
        },
      },
    })));

    expect(order).toEqual(['tool:call_resume_5', 'context:3', 'model']);
    expect(run.events.map(event => event.type)).toEqual([
      LOOP_EVENT_TYPES.ToolResultCompleted,
      LOOP_EVENT_TYPES.ModelOutputCompleted,
    ]);
    expect(run.result).toMatchObject({ type: 'completed', content: 'continued from checkpoint' });
  });

  it('uses AIMessageChunk.concat to assemble streamed tool calls', async () => {
    let calls = 0;
    const observedMessageCounts: number[] = [];
    let persistedMessages: BaseMessage[] = [];
    const loop = new AgentLoop({
      model: streamingModel(async function* (input) {
        calls += 1;
        observedMessageCounts.push(Array.isArray(input) ? input.length : -1);
        if (calls === 1) {
          yield new AIMessageChunk({
            content: '',
            tool_call_chunks: [{ index: 0, id: 'call_1', name: 'lookup', args: '{"query"' }],
          });
          yield new AIMessageChunk({
            content: '',
            tool_call_chunks: [{ index: 0, args: ':"docs"}' }],
          });
          return;
        }
        yield chunk('done');
      }),
    });
    const run = await consume(loop.run(loopInput({
      context: {
        loadMessages: async () => persistedMessages,
      },
      tools: {
        executor: {
          execute: async request => {
            const content = `lookup:${request.call.args.query}`;
            persistedMessages = [
              new AIMessage({
                content: '',
                tool_calls: [{
                  id: request.call.id,
                  name: request.call.name,
                  args: request.call.args,
                  type: 'tool_call',
                }],
              }),
              new ToolMessage({
                tool_call_id: request.call.id,
                content,
              }),
            ];
            return { type: 'completed', content };
          },
        },
      },
    })));

    expect(run.events.map(event => event.type)).toEqual([
      LOOP_EVENT_TYPES.ModelOutputCompleted,
      LOOP_EVENT_TYPES.ToolResultCompleted,
      LOOP_EVENT_TYPES.ModelOutputDelta,
      LOOP_EVENT_TYPES.ModelOutputCompleted,
    ]);
    expect(run.events[0]).toMatchObject({
      toolCalls: [{ id: 'call_1', name: 'lookup', args: { query: 'docs' } }],
    });
    expect(observedMessageCounts).toEqual([0, 2]);
  });

  it('uses LangChain invalid_tool_calls for malformed streamed arguments', async () => {
    let calls = 0;
    const execute = vi.fn<ToolExecutorPort['execute']>();
    const loop = new AgentLoop({
      model: streamingModel(async function* () {
        calls += 1;
        if (calls === 1) {
          yield new AIMessageChunk({
            content: '',
            tool_call_chunks: [{ index: 0, id: 'call_bad', name: 'lookup', args: '{not-json' }],
          });
          return;
        }
        yield chunk('recovered');
      }),
    });
    const run = await consume(loop.run(loopInput({
      tools: { executor: { execute } },
    })));

    expect(run.events[0]).toMatchObject({
      type: LOOP_EVENT_TYPES.ModelOutputCompleted,
      toolCalls: [{ id: 'call_bad', name: 'lookup', args: {} }],
    });
    expect(run.events[1]).toMatchObject({
      type: LOOP_EVENT_TYPES.ToolResultFailed,
      modelToolCallId: 'call_bad',
      executionStarted: false,
      code: 'invalid_tool_arguments',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(run.result).toMatchObject({ type: 'completed', content: 'recovered' });
  });

  it('commits stable sibling results before emitting HITL requests', async () => {
    const loop = new AgentLoop({
      streaming: false,
      model: invokeModel(() => toolChunk([
        { id: 'call_wait_a', name: 'choose_a', args: {} },
        { id: 'call_lookup', name: 'lookup', args: {} },
        { id: 'call_wait_b', name: 'choose_b', args: {} },
      ])),
    });
    const run = await consume(loop.run(loopInput({
      tools: {
        executor: {
          execute: async ({ call }) => call.name === 'lookup'
            ? { type: 'completed', content: 'lookup result' }
            : {
                type: 'requires_user_input',
                request: {
                  prompt: `answer ${call.name}`, inputSchema: { type: 'text' },
                },
              },
        },
      },
    })));

    expect(run.events.map(event => event.type)).toEqual([
      LOOP_EVENT_TYPES.ModelOutputCompleted,
      LOOP_EVENT_TYPES.ToolResultCompleted,
      LOOP_EVENT_TYPES.ToolInputRequired,
      LOOP_EVENT_TYPES.ToolInputRequired,
    ]);
    expect(run.result).toEqual({
      type: 'waiting_for_user', modelToolCallIds: ['call_wait_a', 'call_wait_b'],
    });
  });

  it('isolates a thrown tool failure and still executes its sibling', async () => {
    const executed: string[] = [];
    let calls = 0;
    const loop = new AgentLoop({
      streaming: false,
      model: invokeModel(() => ++calls === 1
        ? toolChunk([
            { id: 'call_fail', name: 'fail', args: {} },
            { id: 'call_ok', name: 'ok', args: {} },
          ])
        : chunk('finished')),
    });
    const run = await consume(loop.run(loopInput({
      tools: {
        executor: {
          execute: async ({ call }) => {
            executed.push(call.id);
            if (call.id === 'call_fail') throw new Error('boom');
            return { type: 'completed', content: 'ok' };
          },
        },
      },
    })));

    expect(executed).toEqual(['call_fail', 'call_ok']);
    expect(run.events.slice(1, 3).map(event => event.type)).toEqual([
      LOOP_EVENT_TYPES.ToolResultFailed,
      LOOP_EVENT_TYPES.ToolResultCompleted,
    ]);
    expect(run.result).toMatchObject({ type: 'completed' });
  });

  it('returns explicit empty, iteration, tool-call, deadline and abort results', async () => {
    const empty = new AgentLoop({ streaming: false, model: invokeModel(() => chunk('')) });
    expect(await consume(empty.run(loopInput()))).toMatchObject({
      events: [], result: { type: 'failed', code: 'empty_model_output' },
    });

    const iterative = new AgentLoop({
      streaming: false,
      model: invokeModel(() => toolChunk([{ name: 'lookup', args: {} }])),
    });
    expect((await consume(iterative.run(loopInput({
      limits: { maxIterations: 1, maxToolCalls: 10 },
      tools: {
        executor: { execute: async () => ({ type: 'completed', content: 'ok' }) },
      },
    })))).result).toMatchObject({ type: 'failed', code: 'max_iterations' });

    const limited = new AgentLoop({
      streaming: false,
      model: invokeModel(() => toolChunk([
        { id: 'call_1', name: 'one', args: {} },
        { id: 'call_2', name: 'two', args: {} },
      ])),
    });
    expect((await consume(limited.run(loopInput({
      limits: { maxIterations: 2, maxToolCalls: 1 },
    })))).result).toMatchObject({ type: 'failed', code: 'max_tool_calls' });

    const invoke = vi.fn(async () => chunk('unused'));
    const deadline = new AgentLoop({
      streaming: false, model: invokeModel(invoke), clock: { nowMs: () => 100 },
    });
    expect((await consume(deadline.run(loopInput({
      limits: { maxIterations: 2, maxToolCalls: 2, deadlineMs: 100 },
    })))).result).toMatchObject({ type: 'failed', code: 'deadline_exceeded' });
    expect(invoke).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    expect((await consume(deadline.run(loopInput({
      limits: { maxIterations: 2, maxToolCalls: 2, signal: controller.signal },
    })))).result).toEqual({ type: 'cancelled' });

    const superseded = new AbortController();
    superseded.abort('task_run_superseded');
    expect((await consume(deadline.run(loopInput({
      limits: { maxIterations: 2, maxToolCalls: 2, signal: superseded.signal },
    })))).result).toEqual({ type: 'cancelled', reason: 'task_run_superseded' });

    const ownershipLost = new AbortController();
    ownershipLost.abort('ownership_lost');
    expect((await consume(deadline.run(loopInput({
      limits: { maxIterations: 2, maxToolCalls: 2, signal: ownershipLost.signal },
    })))).result).toEqual({ type: 'cancelled', reason: 'ownership_lost' });
  });

  it('treats context-build aborts and elapsed deadlines as terminal before model invocation', async () => {
    const invoke = vi.fn(async () => chunk('unused'));
    const controller = new AbortController();
    const aborting = new AgentLoop({ streaming: false, model: invokeModel(invoke) });
    const cancelled = await consume(aborting.run(loopInput({
      context: {
        loadMessages: async () => {
          controller.abort('runtime_shutdown');
          throw new DOMException('Context build was cancelled.', 'AbortError');
        },
      },
      limits: { maxIterations: 2, maxToolCalls: 2, signal: controller.signal },
    })));
    expect(cancelled.result).toEqual({ type: 'cancelled', reason: 'runtime_shutdown' });

    const nowMs = vi.fn()
      .mockReturnValueOnce(99)
      .mockReturnValue(100);
    const expiring = new AgentLoop({
      streaming: false,
      model: invokeModel(invoke),
      clock: { nowMs },
    });
    const expired = await consume(expiring.run(loopInput({
      context: { loadMessages: async () => [] },
      limits: { maxIterations: 2, maxToolCalls: 2, deadlineMs: 100 },
    })));
    expect(expired.result).toMatchObject({ type: 'failed', code: 'deadline_exceeded' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cancels an in-flight tool without recording an ordinary tool failure', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const toolStarted = new Promise<void>(resolve => { started = resolve; });
    const execute = vi.fn<ToolExecutorPort['execute']>(({ signal }) => new Promise((_, reject) => {
      started();
      signal?.addEventListener('abort', () => {
        reject(new DOMException('Tool execution was cancelled.', 'AbortError'));
      }, { once: true });
    }));
    const loop = new AgentLoop({
      streaming: false,
      model: invokeModel(() => toolChunk([{ id: 'call_abort', name: 'lookup', args: {} }])),
    });

    const run = consume(loop.run(loopInput({
      limits: { maxIterations: 2, maxToolCalls: 2, signal: controller.signal },
      tools: { executor: { execute } },
    })));
    await toolStarted;
    controller.abort();

    const cancelled = await run;
    expect(cancelled.result).toEqual({ type: 'cancelled' });
    expect(cancelled.events.map(event => event.type)).toEqual([
      LOOP_EVENT_TYPES.ModelOutputCompleted,
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('classifies model and context overflow failures', async () => {
    const failure = new AgentLoop({
      streaming: false,
      model: invokeModel(async () => { throw new Error('provider unavailable'); }),
    });
    expect((await consume(failure.run(loopInput()))).result).toMatchObject({
      type: 'failed', code: 'model_error', message: 'provider unavailable',
    });

    const overflow = new AgentLoop({
      streaming: false,
      model: invokeModel(async () => {
        throw Object.assign(new Error('too many tokens'), { code: 'model_input_too_large' });
      }),
    });
    expect((await consume(overflow.run(loopInput()))).result).toMatchObject({
      type: 'failed', code: 'model_input_too_large',
    });
  });
});

class TestChatRunnable extends Runnable<BaseLanguageModelInput, AIMessageChunk> {
  readonly lc_namespace = ['tests'];
  constructor(
    private readonly invokeFn: (input: BaseLanguageModelInput) => Promise<AIMessageChunk>,
    private readonly streamFn?: (input: BaseLanguageModelInput) => AsyncIterable<AIMessageChunk>
  ) { super(); }
  invoke(input: BaseLanguageModelInput): Promise<AIMessageChunk> { return this.invokeFn(input); }
  async *_streamIterator(input: BaseLanguageModelInput, _options?: Partial<RunnableConfig>) {
    if (!this.streamFn) {
      yield await this.invoke(input);
      return;
    }
    yield* this.streamFn(input);
  }
}

function invokeModel(
  invoke: (input: BaseLanguageModelInput) => AIMessageChunk | Promise<AIMessageChunk>
): TestChatRunnable {
  return new TestChatRunnable(async input => invoke(input));
}

function streamingModel(
  stream: (input: BaseLanguageModelInput) => AsyncIterable<AIMessageChunk>
): TestChatRunnable {
  return new TestChatRunnable(async () => { throw new Error('invoke must not be used'); }, stream);
}

function chunk(content: string): AIMessageChunk { return new AIMessageChunk({ content }); }
function toolChunk(toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }>) {
  return new AIMessageChunk({
    content: '',
    tool_calls: toolCalls.map(call => ({ type: 'tool_call' as const, ...call })),
  });
}

type AgentLoopInputOverrides = Partial<
  Omit<AgentLoopInput, 'context' | 'tools' | 'policy' | 'resume'>
> & {
  context?: Partial<AgentLoopInput['context']>;
  tools?: Partial<AgentLoopInput['tools']>;
  policy?: AgentLoopInput['policy'];
  resume?: Partial<AgentLoopResumeState>;
};

function loopInput(overrides: AgentLoopInputOverrides = {}): AgentLoopInput {
  const {
    context,
    tools,
    policy,
    resume,
    ...topLevel
  } = overrides;
  const defaultExecutor: ToolExecutorPort = {
    execute: async ({ call }) => ({
      type: 'failed', code: 'tool_not_found', message: `Tool not found: ${call.name}`,
    }),
  };
  return {
    target: { sessionId: 'session_1', taskId: 'task_1', taskRunId: 'task_run_1' },
    context: {
      loadMessages: async () => [],
      ...context,
    },
    tools: {
      definitions: [toolDefinition('lookup'), toolDefinition('one'), toolDefinition('two')],
      executor: defaultExecutor,
      ...tools,
    },
    limits: { maxIterations: 8, maxToolCalls: 16 },
    ...topLevel,
    ...(policy ? { policy } : {}),
    ...(resume ? {
      resume: {
        iterationNo: 0,
        executedToolCalls: 0,
        pendingToolCalls: [],
        ...resume,
      },
    } : {}),
  };
}

function toolDefinition(name: string): StructuredToolInterface {
  return new DynamicStructuredTool({
    name,
    description: name,
    schema: { type: 'object', properties: {}, additionalProperties: true } as const,
    func: async () => name,
  });
}

async function consume(iterator: AsyncGenerator<LoopEvent, LoopResult>) {
  const events: LoopEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}
