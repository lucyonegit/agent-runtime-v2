import { describe, expect, it, vi } from 'vitest';
import {
  AgentLoop,
  type AgentLoopInput,
  type ToolExecutorPort,
} from '../src/agent-loop/agent-loop.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../src/agent-loop/loop-events.js';
import type { LoopResult } from '../src/agent-loop/loop-result.js';
import type { AgentLoopModelPort, AgentToolDefinition } from '../src/agent-loop/model-port.js';
import { ToolCallAssembler } from '../src/agent-loop/tool-call-assembler.js';

describe('AgentLoop', () => {
  it('streams a final answer and returns an explicit completed result', async () => {
    const loop = new AgentLoop({
      model: streamingModel(async function* () {
        yield { content: 'hel' };
        yield {
          content: 'lo',
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, source: 'provider' },
        };
      }),
    });

    const run = await consume(loop.run(loopInput()));

    expect(run.events).toEqual([
      {
        type: LOOP_EVENT_TYPES.ModelOutputDelta,
        outputId: 'output_1',
        channel: 'normal',
        delta: 'hel',
      },
      {
        type: LOOP_EVENT_TYPES.ModelOutputDelta,
        outputId: 'output_1',
        channel: 'normal',
        delta: 'lo',
      },
      {
        type: LOOP_EVENT_TYPES.ModelOutputCompleted,
        outputId: 'output_1',
        content: 'hello',
        toolCalls: [],
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, source: 'provider' },
      },
    ]);
    expect(run.result).toEqual({ type: 'completed', outputId: 'output_1', content: 'hello' });
  });

  it('does not execute a tool until the model tool-call event has been consumed', async () => {
    let modelCalls = 0;
    const execute = vi.fn<ToolExecutorPort['execute']>(async () => ({
      type: 'completed',
      content: 'tool result',
    }));
    const loop = new AgentLoop({
      streaming: false,
      model: {
        invoke: async () => {
          modelCalls += 1;
          return modelCalls === 1
            ? { toolCalls: [{ id: 'call_1', name: 'lookup', args: { q: 'docs' } }] }
            : { content: 'done' };
        },
      },
    });
    const iterator = loop.run(loopInput({ toolExecutor: { execute } }));

    const modelEvent = await iterator.next();
    expect(modelEvent).toMatchObject({
      done: false,
      value: { type: LOOP_EVENT_TYPES.ModelOutputCompleted, toolCalls: [{ id: 'call_1' }] },
    });
    expect(execute).not.toHaveBeenCalled();

    const toolEvent = await iterator.next();
    expect(toolEvent).toMatchObject({
      done: false,
      value: { type: LOOP_EVENT_TYPES.ToolResultCompleted, toolCallId: 'call_1' },
    });
    expect(execute).toHaveBeenCalledTimes(1);

    await iterator.next();
    const completed = await iterator.next();
    expect(completed).toEqual({
      done: true,
      value: { type: 'completed', outputId: 'output_2', content: 'done' },
    });
  });

  it('waits for each sibling tool result to be consumed before executing the next tool', async () => {
    const executed: string[] = [];
    let modelCalls = 0;
    const loop = new AgentLoop({
      streaming: false,
      model: {
        invoke: async () => {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  { id: 'call_1', name: 'one', args: {} },
                  { id: 'call_2', name: 'two', args: {} },
                ],
              }
            : { content: 'done' };
        },
      },
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

  it('assembles streamed tool chunks, executes serially, and continues with tool results', async () => {
    let modelCalls = 0;
    const observedMessages: number[] = [];
    const model: AgentLoopModelPort = {
      invoke: async () => { throw new Error('invoke must not be used'); },
      stream: async function* (request) {
        modelCalls += 1;
        observedMessages.push(request.messages.length);
        if (modelCalls === 1) {
          yield {
            toolCallChunks: [{ index: 0, id: 'call_1', name: 'lookup', args: '{"query"' }],
          };
          yield { toolCallChunks: [{ index: 0, args: ':"docs"}' }] };
          return;
        }
        yield { content: 'done' };
      },
    };
    const loop = new AgentLoop({ model });
    const run = await consume(loop.run(loopInput({
      toolExecutor: {
        execute: async request => ({
          type: 'completed',
          content: `lookup:${request.call.args.query}`,
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
    expect(observedMessages).toEqual([0, 2]);
    expect(run.result).toMatchObject({ type: 'completed', content: 'done' });
  });

  it('turns invalid streamed arguments into a failed tool result instead of dropping the call', async () => {
    let modelCalls = 0;
    const execute = vi.fn<ToolExecutorPort['execute']>();
    const loop = new AgentLoop({
      model: streamingModel(async function* () {
        modelCalls += 1;
        if (modelCalls === 1) {
          yield {
            toolCallChunks: [{ index: 0, id: 'call_bad', name: 'lookup', args: '{not-json' }],
          };
          return;
        }
        yield { content: 'recovered' };
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

  it('fails on conflicting streamed tool identity fields', async () => {
    const loop = new AgentLoop({
      model: streamingModel(async function* () {
        yield { toolCallChunks: [{ index: 0, id: 'call_1', name: 'first', args: '{}' }] };
        yield { toolCallChunks: [{ index: 0, name: 'second' }] };
      }),
    });

    const run = await consume(loop.run(loopInput()));

    expect(run.events.map(event => event.type)).toEqual([
      LOOP_EVENT_TYPES.ModelOutputCompleted,
      LOOP_EVENT_TYPES.ToolResultFailed,
    ]);
    expect(run.result).toMatchObject({ type: 'failed', code: 'model_error' });
  });

  it('commits stable sibling results before emitting every HITL request', async () => {
    const loop = new AgentLoop({
      streaming: false,
      model: {
        invoke: async () => ({
          toolCalls: [
            { id: 'call_wait_a', name: 'choose_a', args: {} },
            { id: 'call_lookup', name: 'lookup', args: {} },
            { id: 'call_wait_b', name: 'choose_b', args: {} },
          ],
        }),
      },
    });
    const run = await consume(loop.run(loopInput({
      toolExecutor: {
        execute: async ({ call }) => call.name === 'lookup'
          ? { type: 'completed', content: 'lookup result' }
          : {
              type: 'requires_user_input',
              request: {
                source: 'tool',
                answerMode: 'as_tool_result',
                prompt: `answer ${call.name}`,
                inputSchema: { type: 'text' },
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
      type: 'waiting_user_input',
      toolCallIds: ['call_wait_a', 'call_wait_b'],
    });
  });

  it('isolates a thrown tool failure and still executes its sibling', async () => {
    const calls: string[] = [];
    let modelCalls = 0;
    const loop = new AgentLoop({
      streaming: false,
      model: {
        invoke: async () => {
          modelCalls += 1;
          return modelCalls === 1
            ? {
                toolCalls: [
                  { id: 'call_fail', name: 'fail', args: {} },
                  { id: 'call_ok', name: 'ok', args: {} },
                ],
              }
            : { content: 'finished' };
        },
      },
    });
    const run = await consume(loop.run(loopInput({
      toolExecutor: {
        execute: async ({ call }) => {
          calls.push(call.id);
          if (call.id === 'call_fail') throw new Error('boom');
          return { type: 'completed', content: 'ok' };
        },
      },
    })));

    expect(calls).toEqual(['call_fail', 'call_ok']);
    expect(run.events.slice(1, 3).map(event => event.type)).toEqual([
      LOOP_EVENT_TYPES.ToolResultFailed,
      LOOP_EVENT_TYPES.ToolResultCompleted,
    ]);
    expect(run.result).toMatchObject({ type: 'completed' });
  });

  it('returns explicit empty, iteration, and tool-call limit failures', async () => {
    const empty = new AgentLoop({
      streaming: false,
      model: { invoke: async () => ({ content: '' }) },
    });
    await expect(consume(empty.run(loopInput()))).resolves.toMatchObject({
      events: [],
      result: { type: 'failed', code: 'empty_model_output' },
    });

    const iterative = new AgentLoop({
      streaming: false,
      model: { invoke: async () => ({ toolCalls: [{ name: 'lookup', args: {} }] }) },
    });
    const iterationRun = await consume(iterative.run(loopInput({
      limits: { maxIterations: 1, maxToolCalls: 10 },
      toolExecutor: { execute: async () => ({ type: 'completed', content: 'ok' }) },
    })));
    expect(iterationRun.result).toMatchObject({ type: 'failed', code: 'max_iterations' });

    const toolLimited = new AgentLoop({
      streaming: false,
      model: {
        invoke: async () => ({
          toolCalls: [
            { id: 'call_1', name: 'one', args: {} },
            { id: 'call_2', name: 'two', args: {} },
          ],
        }),
      },
    });
    const limitedRun = await consume(toolLimited.run(loopInput({
      limits: { maxIterations: 2, maxToolCalls: 1 },
    })));
    expect(limitedRun.events).toHaveLength(1);
    expect(limitedRun.result).toMatchObject({ type: 'failed', code: 'max_tool_calls' });
  });

  it('stops before model work on deadline or abort', async () => {
    const invoke = vi.fn<AgentLoopModelPort['invoke']>();
    const deadlineLoop = new AgentLoop({
      streaming: false,
      model: { invoke },
      clock: { nowMs: () => 100 },
    });
    const deadline = await consume(deadlineLoop.run(loopInput({
      limits: { maxIterations: 2, maxToolCalls: 2, deadlineMs: 100 },
    })));
    expect(deadline.result).toMatchObject({ type: 'failed', code: 'deadline_exceeded' });
    expect(invoke).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    const cancelled = await consume(deadlineLoop.run(loopInput({
      limits: { maxIterations: 2, maxToolCalls: 2, signal: controller.signal },
    })));
    expect(cancelled.result).toEqual({ type: 'cancelled' });
  });

  it('classifies model and context overflow failures', async () => {
    const modelFailure = new AgentLoop({
      streaming: false,
      model: { invoke: async () => { throw new Error('provider unavailable'); } },
    });
    expect((await consume(modelFailure.run(loopInput()))).result).toMatchObject({
      type: 'failed',
      code: 'model_error',
      message: 'provider unavailable',
    });

    const overflow = new AgentLoop({
      streaming: false,
      model: {
        invoke: async () => {
          throw Object.assign(new Error('too many tokens'), { code: 'context_overflow' });
        },
      },
    });
    expect((await consume(overflow.run(loopInput()))).result).toMatchObject({
      type: 'failed',
      code: 'context_overflow',
    });
  });
});

describe('ToolCallAssembler', () => {
  it('sorts out-of-order indexes and creates stable fallback IDs', () => {
    const assembler = new ToolCallAssembler();
    assembler.add([{ index: 1, name: 'second', args: '{}' }]);
    assembler.add([{ index: 0, name: 'first', args: '{"value":1}' }]);

    expect(assembler.finish(index => `fallback_${index}`)).toEqual({
      toolCalls: [
        { id: 'fallback_0', name: 'first', args: { value: 1 } },
        { id: 'fallback_1', name: 'second', args: {} },
      ],
      errors: [],
    });
  });
});

function streamingModel(
  stream: NonNullable<AgentLoopModelPort['stream']>
): AgentLoopModelPort {
  return {
    invoke: async () => { throw new Error('invoke must not be used'); },
    stream,
  };
}

function loopInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  let outputNo = 0;
  return {
    messages: [],
    target: {
      sessionId: 'session_1',
      jobId: 'job_1',
      attemptId: 'attempt_1',
    },
    tools: [toolDefinition('lookup'), toolDefinition('one'), toolDefinition('two')],
    toolExecutor: {
      execute: async ({ call }) => ({
        type: 'failed',
        code: 'tool_not_found',
        message: `Tool not found: ${call.name}`,
      }),
    },
    outputIdFactory: () => `output_${++outputNo}`,
    limits: { maxIterations: 8, maxToolCalls: 16 },
    ...overrides,
  };
}

function toolDefinition(name: string): AgentToolDefinition {
  return {
    name,
    description: name,
    schema: { type: 'object' },
    sideEffectLevel: 'read_only',
  };
}

async function consume(
  iterator: AsyncGenerator<LoopEvent, LoopResult>
): Promise<{ events: LoopEvent[]; result: LoopResult }> {
  const events: LoopEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}
