import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { CoreStepEventType, ReactCore, type ReactCoreTool } from '../src/core/index.js';

const testToolContext = {
  sessionId: 'session_test',
  taskId: 'task_test',
  sandboxRoot: '/tmp/agent-runtime-v2-test-sandbox',
};

describe('ReactCore', () => {
  it('streams natural assistant output as the final answer', async () => {
    const core = new ReactCore({
      model: {
        invoke: async () => {
          throw new Error('invoke should not be used when streaming is enabled');
        },
        stream: async function* () {
          yield { content: 'hel' };
          yield { content: 'lo' };
        },
      },
      tools: [],
      streaming: true,
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));
    const outputId = (events[0] as { outputId: string }).outputId;

    expect(events[0]).toEqual({
        type: CoreStepEventType.ModelOutputDelta,
        channel: 'normal',
        delta: 'hel',
        outputId: expect.any(String),
    });
    expect(events[1]).toEqual({
        type: CoreStepEventType.ModelOutputDelta,
        channel: 'normal',
        delta: 'lo',
        outputId,
    });
    expect(events[2]).toEqual({
        type: CoreStepEventType.ModelOutputCompleted,
        channel: 'final',
        content: 'hello',
        outputId,
    });
  });

  it('parses streamed tool call chunks, executes tools, then stops on natural final output', async () => {
    let calls = 0;
    const tool: ReactCoreTool = {
      name: 'lookup',
      execute: async args => ({
        type: 'completed',
        content: `lookup:${args.query}`,
      }),
    };
    const core = new ReactCore({
      model: {
        invoke: async () => {
          throw new Error('invoke should not be used when streaming is enabled');
        },
        stream: async function* () {
          calls += 1;
          if (calls === 1) {
            yield {
              tool_call_chunks: [{
                index: 0,
                id: 'call_1',
                name: 'lookup',
                args: '{"query"',
              }],
            };
            yield {
              tool_call_chunks: [{
                index: 0,
                args: ':"docs"}',
              }],
            };
            return;
          }
          yield { content: 'done' };
        },
      },
      tools: [tool],
      streaming: true,
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events.map(event => event.type)).toEqual([
      CoreStepEventType.ModelOutputCompleted,
      CoreStepEventType.ToolResultCompleted,
      CoreStepEventType.ModelOutputDelta,
      CoreStepEventType.ModelOutputCompleted,
    ]);
    expect(events[0]).toMatchObject({
      type: CoreStepEventType.ModelOutputCompleted,
      channel: 'normal',
      toolCalls: [{ id: 'call_1', name: 'lookup', args: { query: 'docs' } }],
    });
    expect(events[1]).toMatchObject({
      type: CoreStepEventType.ToolResultCompleted,
      toolCallId: 'call_1',
      toolName: 'lookup',
      content: 'lookup:docs',
    });
    expect(events[2]).toMatchObject({
      type: CoreStepEventType.ModelOutputDelta,
      channel: 'normal',
      delta: 'done',
    });
    expect(events[3]).toMatchObject({
      type: CoreStepEventType.ModelOutputCompleted,
      channel: 'final',
      content: 'done',
    });
  });

  it('treats a no-tool assistant response as the final answer', async () => {
    const core = new ReactCore({
      model: {
        invoke: async () => new AIMessage('natural final answer'),
      },
      tools: [],
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events).toEqual([
      {
        type: CoreStepEventType.ModelOutputCompleted,
        outputId: expect.any(String),
        channel: 'final',
        content: 'natural final answer',
      },
    ]);
  });

  it('emits provider token usage from non-streaming model responses', async () => {
    const message = new AIMessage('answer') as AIMessage & {
      usage_metadata?: Record<string, unknown>;
    };
    message.usage_metadata = {
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
    };
    const core = new ReactCore({
      model: {
        invoke: async () => message,
      },
      tools: [],
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events[0]).toMatchObject({
      type: CoreStepEventType.ModelOutputCompleted,
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        source: 'provider',
      },
    });
  });

  it('emits provider token usage from the final streaming chunk', async () => {
    const core = new ReactCore({
      model: {
        invoke: async () => {
          throw new Error('invoke should not be used when streaming is enabled');
        },
        stream: async function* () {
          yield { content: 'hello' };
          yield {
            usage: {
              inputTokens: 20,
              outputTokens: 3,
              totalTokens: 23,
              source: 'provider',
            },
          };
        },
      },
      tools: [],
      streaming: true,
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events.at(-1)).toMatchObject({
      type: CoreStepEventType.ModelOutputCompleted,
      usage: {
        inputTokens: 20,
        outputTokens: 3,
        totalTokens: 23,
        source: 'provider',
      },
    });
  });

  it('emits no events for an empty no-tool model output', async () => {
    const core = new ReactCore({
      model: {
        invoke: async () => new AIMessage(''),
      },
      tools: [],
      maxIterations: 1,
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events).toEqual([]);
  });

  it('executes completed tools and continues the loop', async () => {
    let calls = 0;
    const tool: ReactCoreTool = {
      name: 'lookup',
      execute: async () => ({
        type: 'completed',
        content: 'lookup result',
        result: { value: 42 },
      }),
    };
    const core = new ReactCore({
      model: {
        invoke: async () => {
          calls += 1;
          if (calls === 1) {
            return new AIMessage({
              content: '',
              tool_calls: [{
                id: 'call_1',
                name: 'lookup',
                args: { q: 'answer' },
                type: 'tool_call',
              }],
            });
          }
          return new AIMessage('final answer');
        },
      },
      tools: [tool],
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events.map(event => event.type)).toEqual([
      CoreStepEventType.ModelOutputCompleted,
      CoreStepEventType.ToolResultCompleted,
      CoreStepEventType.ModelOutputCompleted,
    ]);
    expect(events[1]).toMatchObject({
      type: CoreStepEventType.ToolResultCompleted,
      toolCallId: 'call_1',
      toolName: 'lookup',
      content: 'lookup result',
    });
    expect(events[2]).toMatchObject({
      type: CoreStepEventType.ModelOutputCompleted,
      channel: 'final',
      content: 'final answer',
    });
  });

  it('passes the run tool context into tool execution', async () => {
    const receivedContexts: unknown[] = [];
    const tool: ReactCoreTool = {
      name: 'write_note',
      execute: async (_args, context) => {
        receivedContexts.push(context);
        return {
          type: 'completed',
          content: 'ok',
        };
      },
    };
    const core = new ReactCore({
      model: {
        invoke: async () => new AIMessage({
          content: '',
          tool_calls: [{
            id: 'call_1',
            name: 'write_note',
            args: { path: 'note.md' },
            type: 'tool_call',
          }],
        }),
      },
      tools: [tool],
      maxIterations: 1,
    });

    await collect(core.run({
      messages: [],
      toolContext: {
        sessionId: 'session_1',
        taskId: 'task_1',
        sandboxRoot: '/tmp/agent-sandbox',
      },
    }));

    expect(receivedContexts).toEqual([{
      sessionId: 'session_1',
      taskId: 'task_1',
      sandboxRoot: '/tmp/agent-sandbox',
    }]);
  });

  it('emits a user input requirement and pauses when a tool requires HITL', async () => {
    const core = new ReactCore({
      model: {
        invoke: async () => new AIMessage({
          content: '',
          tool_calls: [{
            id: 'call_1',
            name: 'choose_card',
            args: { count: 3 },
            type: 'tool_call',
          }],
        }),
      },
      tools: [{
        name: 'choose_card',
        execute: async () => ({
          type: 'requires_user_input',
          request: {
            source: 'tool',
            resumeMode: 'answer_as_tool_result',
            prompt: 'Choose cards',
            input: { type: 'text' },
          },
        }),
      }],
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events.map(event => event.type)).toEqual([
      CoreStepEventType.ModelOutputCompleted,
      CoreStepEventType.ToolInputRequired,
    ]);
    expect(events[1]).toMatchObject({
      type: CoreStepEventType.ToolInputRequired,
      toolCallId: 'call_1',
      toolName: 'choose_card',
      request: {
        resumeMode: 'answer_as_tool_result',
        prompt: 'Choose cards',
      },
    });
  });

  it('emits every HITL input request from the same tool-call batch', async () => {
    const core = new ReactCore({
      model: {
        invoke: async () => new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'call_card',
              name: 'choose_card',
              args: { count: 3 },
              type: 'tool_call',
            },
            {
              id: 'call_spread',
              name: 'choose_spread',
              args: { options: ['past_present_future', 'celtic_cross'] },
              type: 'tool_call',
            },
          ],
        }),
      },
      tools: [
        {
          name: 'choose_card',
          execute: async () => ({
            type: 'requires_user_input',
            request: {
              source: 'tool',
              resumeMode: 'answer_as_tool_result',
              prompt: 'Choose cards',
              input: { type: 'text' },
            },
          }),
        },
        {
          name: 'choose_spread',
          execute: async () => ({
            type: 'requires_user_input',
            request: {
              source: 'tool',
              resumeMode: 'answer_as_tool_result',
              prompt: 'Choose a spread',
              input: {
                type: 'single_choice',
                options: [
                  { label: 'Past Present Future', value: 'past_present_future' },
                  { label: 'Celtic Cross', value: 'celtic_cross' },
                ],
              },
            },
          }),
        },
      ],
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events).toEqual([
      {
        type: CoreStepEventType.ModelOutputCompleted,
        outputId: expect.any(String),
        channel: 'normal',
        content: '',
        toolCalls: [
          {
            id: 'call_card',
            name: 'choose_card',
            args: { count: 3 },
          },
          {
            id: 'call_spread',
            name: 'choose_spread',
            args: { options: ['past_present_future', 'celtic_cross'] },
          },
        ],
      },
      {
        type: CoreStepEventType.ToolInputRequired,
        toolCallId: 'call_card',
        toolName: 'choose_card',
        request: {
          source: 'tool',
          resumeMode: 'answer_as_tool_result',
          prompt: 'Choose cards',
          input: { type: 'text' },
        },
      },
      {
        type: CoreStepEventType.ToolInputRequired,
        toolCallId: 'call_spread',
        toolName: 'choose_spread',
        request: {
          source: 'tool',
          resumeMode: 'answer_as_tool_result',
          prompt: 'Choose a spread',
          input: {
            type: 'single_choice',
            options: [
              { label: 'Past Present Future', value: 'past_present_future' },
              { label: 'Celtic Cross', value: 'celtic_cross' },
            ],
          },
        },
      },
    ]);
  });

  it('treats unknown tool calls as failed tool results instead of model input pauses', async () => {
    const core = new ReactCore({
      model: {
        invoke: async () => new AIMessage({
          content: 'I need more information.',
          tool_calls: [{
            id: 'call_input',
            name: 'request_user_input',
            args: { prompt: 'What should I optimize for?' },
            type: 'tool_call',
          }],
        }),
      },
      tools: [],
      maxIterations: 1,
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events).toEqual([
      {
        type: CoreStepEventType.ModelOutputCompleted,
        outputId: expect.any(String),
        channel: 'normal',
        content: 'I need more information.',
        toolCalls: [{
          id: 'call_input',
          name: 'request_user_input',
          args: { prompt: 'What should I optimize for?' },
        }],
      },
      {
        type: CoreStepEventType.ToolResultFailed,
        toolCallId: 'call_input',
        toolName: 'request_user_input',
        error: 'Tool not found: request_user_input',
        durationMs: expect.any(Number),
      },
    ]);
  });

  it('executes non-HITL tool calls before pausing for HITL', async () => {
    const core = new ReactCore({
      model: {
        invoke: async () => new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'call_lookup',
              name: 'lookup',
              args: { query: 'keep this result' },
              type: 'tool_call',
            },
            {
              id: 'call_wait',
              name: 'choose_card',
              args: { count: 3 },
              type: 'tool_call',
            },
          ],
        }),
      },
      tools: [
        {
          name: 'choose_card',
          execute: async () => ({
            type: 'requires_user_input',
            request: {
              source: 'tool',
              resumeMode: 'answer_as_tool_result',
              prompt: 'Choose cards',
              input: { type: 'text' },
            },
          }),
        },
        {
          name: 'lookup',
          execute: async args => ({
            type: 'completed',
            content: `lookup:${args.query}`,
          }),
        },
      ],
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events).toEqual([
      {
        type: CoreStepEventType.ModelOutputCompleted,
        outputId: expect.any(String),
        channel: 'normal',
        content: '',
        toolCalls: [
          {
            id: 'call_lookup',
            name: 'lookup',
            args: { query: 'keep this result' },
          },
          {
            id: 'call_wait',
            name: 'choose_card',
            args: { count: 3 },
          },
        ],
      },
      {
        type: CoreStepEventType.ToolResultCompleted,
        toolCallId: 'call_lookup',
        toolName: 'lookup',
        content: 'lookup:keep this result',
        result: undefined,
        durationMs: expect.any(Number),
      },
      {
        type: CoreStepEventType.ToolInputRequired,
        toolCallId: 'call_wait',
        toolName: 'choose_card',
        request: {
          source: 'tool',
          resumeMode: 'answer_as_tool_result',
          prompt: 'Choose cards',
          input: { type: 'text' },
        },
      },
    ]);
  });

  it('does not drop non-HITL sibling tool calls that appear after a HITL tool call', async () => {
    const core = new ReactCore({
      model: {
        invoke: async () => new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'call_wait',
              name: 'choose_card',
              args: { count: 3 },
              type: 'tool_call',
            },
            {
              id: 'call_lookup',
              name: 'lookup',
              args: { query: 'run after hitl is detected' },
              type: 'tool_call',
            },
          ],
        }),
      },
      tools: [
        {
          name: 'choose_card',
          execute: async () => ({
            type: 'requires_user_input',
            request: {
              source: 'tool',
              resumeMode: 'answer_as_tool_result',
              prompt: 'Choose cards',
              input: { type: 'text' },
            },
          }),
        },
        {
          name: 'lookup',
          execute: async args => ({
            type: 'completed',
            content: `lookup:${args.query}`,
          }),
        },
      ],
    });

    const events = await collect(core.run({ messages: [], toolContext: testToolContext }));

    expect(events).toEqual([
      {
        type: CoreStepEventType.ModelOutputCompleted,
        outputId: expect.any(String),
        channel: 'normal',
        content: '',
        toolCalls: [
          {
            id: 'call_wait',
            name: 'choose_card',
            args: { count: 3 },
          },
          {
            id: 'call_lookup',
            name: 'lookup',
            args: { query: 'run after hitl is detected' },
          },
        ],
      },
      {
        type: CoreStepEventType.ToolResultCompleted,
        toolCallId: 'call_lookup',
        toolName: 'lookup',
        content: 'lookup:run after hitl is detected',
        result: undefined,
        durationMs: expect.any(Number),
      },
      {
        type: CoreStepEventType.ToolInputRequired,
        toolCallId: 'call_wait',
        toolName: 'choose_card',
        request: {
          source: 'tool',
          resumeMode: 'answer_as_tool_result',
          prompt: 'Choose cards',
          input: { type: 'text' },
        },
      },
    ]);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
