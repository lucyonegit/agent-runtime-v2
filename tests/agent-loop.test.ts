import { describe, expect, it, vi } from 'vitest';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { AIMessageChunk } from '@langchain/core/messages';
import { Runnable, type RunnableConfig } from '@langchain/core/runnables';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import {
  AgentLoop,
  type AgentLoopInput,
  type ToolExecutorPort,
} from '../src/agent-loop/agent-loop.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../src/agent-loop/loop-events.js';
import type { LoopResult } from '../src/agent-loop/loop-result.js';

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
    const iterator = loop.run(loopInput({ toolExecutor: { execute } }));

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: LOOP_EVENT_TYPES.ModelOutputCompleted, toolCalls: [{ id: 'call_1' }] },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: LOOP_EVENT_TYPES.ToolResultCompleted, toolCallId: 'call_1' },
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
      toolExecutor: {
        execute: async ({ call }) => {
          executed.push(call.id);
          return { type: 'completed', content: call.id };
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

  it('uses AIMessageChunk.concat to assemble streamed tool calls', async () => {
    let calls = 0;
    const observedMessageCounts: number[] = [];
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
      toolExecutor: {
        execute: async request => ({
          type: 'completed', content: `lookup:${request.call.args.query}`,
        }),
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
    const run = await consume(loop.run(loopInput({ toolExecutor: { execute } })));

    expect(run.events[0]).toMatchObject({
      type: LOOP_EVENT_TYPES.ModelOutputCompleted,
      toolCalls: [{ id: 'call_bad', name: 'lookup', args: {} }],
    });
    expect(run.events[1]).toMatchObject({
      type: LOOP_EVENT_TYPES.ToolResultFailed,
      toolCallId: 'call_bad',
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
      toolExecutor: {
        execute: async ({ call }) => call.name === 'lookup'
          ? { type: 'completed', content: 'lookup result' }
          : {
              type: 'requires_user_input',
              request: {
                source: 'tool', answerMode: 'as_tool_result',
                prompt: `answer ${call.name}`, inputSchema: { type: 'text' },
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
      type: 'waiting_user_input', toolCallIds: ['call_wait_a', 'call_wait_b'],
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
      toolExecutor: {
        execute: async ({ call }) => {
          executed.push(call.id);
          if (call.id === 'call_fail') throw new Error('boom');
          return { type: 'completed', content: 'ok' };
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
      toolExecutor: { execute: async () => ({ type: 'completed', content: 'ok' }) },
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
        throw Object.assign(new Error('too many tokens'), { code: 'context_overflow' });
      }),
    });
    expect((await consume(overflow.run(loopInput()))).result).toMatchObject({
      type: 'failed', code: 'context_overflow',
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

function loopInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  let outputNo = 0;
  return {
    messages: [],
    target: { sessionId: 'session_1', jobId: 'job_1', attemptId: 'attempt_1' },
    tools: [toolDefinition('lookup'), toolDefinition('one'), toolDefinition('two')],
    toolExecutor: {
      execute: async ({ call }) => ({
        type: 'failed', code: 'tool_not_found', message: `Tool not found: ${call.name}`,
      }),
    },
    outputIdFactory: () => `output_${++outputNo}`,
    limits: { maxIterations: 8, maxToolCalls: 16 },
    ...overrides,
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
