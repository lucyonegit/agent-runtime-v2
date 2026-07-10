import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextBuilder } from '../src/context/index.js';
import {
  CoreStepEventType,
  ReactCore,
  type CoreStepEvent,
  type ReactCoreModel,
} from '../src/core/index.js';
import { AgentSessionPatchType } from '../src/domain/index.js';
import { ReactAgent } from '../src/orchestration/index.js';
import { FileSessionStore } from '../src/storage/index.js';

describe('ReactAgent orchestration', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-orchestrator-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists the react system prompt before the user message and includes it in model context', async () => {
    const store = new FileSessionStore(root);
    let modelMessages: BaseMessage[] = [];
    const agent = new ReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core: new ReactCore({
        model: {
          invoke: async messages => {
            modelMessages = messages;
            return new AIMessage('hello');
          },
        },
        tools: [],
      }),
      ids: fixedIds(['task_1', 'msg_system', 'msg_user', 'msg_assistant']),
      clock: tickingClock(100),
    });

    await agent.run({ sessionId: 'session_1', input: 'Say hello' });

    await expect(store.listMessages('session_1')).resolves.toMatchObject([
      {
        id: 'msg_system',
        taskId: 'task_1',
        rowId: 1,
        role: 'system',
        metadata: {
          kind: 'system_prompt',
          executor: 'react',
          promptVersion: 'react-v3',
          scope: 'task',
        },
      },
      { id: 'msg_user', taskId: 'task_1', rowId: 2, role: 'user', content: 'Say hello' },
      { id: 'msg_assistant', taskId: 'task_1', rowId: 3, role: 'assistant', content: 'hello' },
    ]);
    expect(modelMessages[0]).toBeInstanceOf(SystemMessage);
  });

  it('streams deltas to the live event handler and stores only the completed message', async () => {
    const store = new FileSessionStore(root);
    const patches: unknown[] = [];
    const agent = new ReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core: new ReactCore({
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
      }),
      ids: fixedIds(['task_1', 'msg_system', 'msg_user', 'msg_assistant']),
      clock: tickingClock(100),
      onEvent: async event => {
        patches.push(event);
      },
    });

    await agent.run({ sessionId: 'session_1', input: 'Say hello' });

    expect(patches).toEqual([
      {
        type: AgentSessionPatchType.UserMessageCreated,
        sessionId: 'session_1',
        message: expect.objectContaining({
          id: 'msg_user',
          taskId: 'task_1',
          rowId: 2,
          content: 'Say hello',
        }),
      },
      {
        type: AgentSessionPatchType.TaskStatusChanged,
        sessionId: 'session_1',
        task: expect.objectContaining({
          id: 'task_1',
          kind: 'react',
          status: 'running',
        }),
      },
      {
        type: AgentSessionPatchType.ModelOutputDelta,
        sessionId: 'session_1',
        taskId: 'task_1',
        messageId: 'msg_assistant',
        channel: 'normal',
        outputId: expect.any(String),
        delta: 'hel',
      },
      {
        type: AgentSessionPatchType.ModelOutputDelta,
        sessionId: 'session_1',
        taskId: 'task_1',
        messageId: 'msg_assistant',
        channel: 'normal',
        outputId: expect.any(String),
        delta: 'lo',
      },
      {
        type: AgentSessionPatchType.ModelOutputCompleted,
        sessionId: 'session_1',
        outputId: expect.any(String),
        message: expect.objectContaining({
          id: 'msg_assistant',
          taskId: 'task_1',
          rowId: 3,
          channel: 'final',
          content: 'hello',
        }),
      },
      {
        type: AgentSessionPatchType.ContextUsageUpdated,
        sessionId: 'session_1',
        stats: expect.objectContaining({
          sessionId: 'session_1',
        }),
      },
      {
        type: AgentSessionPatchType.TaskStatusChanged,
        sessionId: 'session_1',
        task: expect.objectContaining({
          id: 'task_1',
          status: 'completed',
        }),
      },
    ]);
    await expect(store.listMessages('session_1')).resolves.toMatchObject([
      { id: 'msg_system', role: 'system' },
      { id: 'msg_user', role: 'user', content: 'Say hello' },
      { id: 'msg_assistant', role: 'assistant', channel: 'final', content: 'hello' },
    ]);
  });

  it('passes session task sandbox context into tool execution', async () => {
    const store = new FileSessionStore(root);
    const receivedContexts: unknown[] = [];
    const agent = new ReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core: new ReactCore({
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
        tools: [{
          name: 'write_note',
          execute: async (_args, context) => {
            receivedContexts.push(context);
            return {
              type: 'completed',
              content: 'ok',
            };
          },
        }],
        maxIterations: 1,
      }),
      sandboxRoot: join(root, 'sandbox'),
      ids: fixedIds(['task_1', 'msg_system', 'msg_user', 'msg_assistant', 'msg_tool']),
      clock: tickingClock(100),
    });

    await agent.run({ sessionId: 'session_1', input: 'write note' });

    expect(receivedContexts).toEqual([{
      sessionId: 'session_1',
      taskId: 'task_1',
      sandboxRoot: join(root, 'sandbox'),
    }]);
  });

  it('emits session patches that can be forwarded by an SSE API', async () => {
    const store = new FileSessionStore(root);
    const events: unknown[] = [];
    const agent = new ReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core: new ReactCore({
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
      }),
      ids: fixedIds(['task_1', 'msg_system', 'msg_user', 'msg_assistant']),
      clock: tickingClock(100),
      onEvent: async event => {
        events.push(event);
      },
    });

    const result = await agent.run({ sessionId: 'session_1', input: 'Say hello' });

    expect(result.status).toBe('completed');
    expect(events.map(event => (event as { type: string }).type)).toEqual([
      AgentSessionPatchType.UserMessageCreated,
      AgentSessionPatchType.TaskStatusChanged,
      AgentSessionPatchType.ModelOutputDelta,
      AgentSessionPatchType.ModelOutputDelta,
      AgentSessionPatchType.ModelOutputCompleted,
      AgentSessionPatchType.ContextUsageUpdated,
      AgentSessionPatchType.TaskStatusChanged,
    ]);
    expect(events[0]).toMatchObject({
      type: AgentSessionPatchType.UserMessageCreated,
      message: {
        taskId: 'task_1',
        id: 'msg_user',
        content: 'Say hello',
      },
    });
    expect(events[1]).toMatchObject({
      type: AgentSessionPatchType.TaskStatusChanged,
      task: {
        id: 'task_1',
        status: 'running',
      },
    });
    expect(events[2]).toMatchObject({
      type: AgentSessionPatchType.ModelOutputDelta,
      sessionId: 'session_1',
      taskId: 'task_1',
      messageId: 'msg_assistant',
      delta: 'hel',
    });
    expect(events[6]).toMatchObject({
      type: AgentSessionPatchType.TaskStatusChanged,
      sessionId: 'session_1',
      task: {
        id: 'task_1',
        status: 'completed',
      },
    });
  });

  it('marks the task failed when the core completes without any events', async () => {
    const store = new FileSessionStore(root);
    const patches: unknown[] = [];
    const agent = new ReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core: new ReactCore({
        model: {
          invoke: async () => new AIMessage(''),
        },
        tools: [],
        maxIterations: 1,
      }),
      ids: fixedIds(['task_1', 'msg_system', 'msg_user']),
      clock: tickingClock(100),
      onEvent: async event => {
        patches.push(event);
      },
    });

    const result = await agent.run({ sessionId: 'session_1', input: 'Say hello' });

    expect(result).toEqual({
      sessionId: 'session_1',
      taskId: 'task_1',
      status: 'failed',
    });
    await expect(store.listTasks('session_1')).resolves.toMatchObject([
      {
        id: 'task_1',
        status: 'failed',
        error: { message: 'Agent core completed without producing any events' },
      },
    ]);
    expect(patches.at(-1)).toMatchObject({
      type: AgentSessionPatchType.TaskStatusChanged,
      sessionId: 'session_1',
      task: {
        id: 'task_1',
        status: 'failed',
        error: { message: 'Agent core completed without producing any events' },
      },
    });
  });

  it('pauses on tool-triggered user input and persists the pending request', async () => {
    const store = new FileSessionStore(root);
    const agent = new ReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core: new ReactCore({
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
      }),
      ids: fixedIds(['task_1', 'msg_system', 'msg_user', 'msg_ai', 'input_1']),
      clock: tickingClock(100),
    });

    const result = await agent.run({ sessionId: 'session_1', input: 'Draw cards' });

    expect(result.status).toBe('waiting_user_input');
    await expect(store.listTasks('session_1')).resolves.toMatchObject([
      { id: 'task_1', status: 'waiting_user_input', waitingRequestId: 'input_1' },
    ]);
    await expect(store.listMessages('session_1')).resolves.toMatchObject([
      { id: 'msg_system', role: 'system' },
      { id: 'msg_user', role: 'user', content: 'Draw cards' },
      { id: 'msg_ai', role: 'assistant', toolCalls: [{ id: 'call_1' }] },
    ]);
    await expect(store.listInputRequests('session_1')).resolves.toMatchObject([
      { id: 'input_1', status: 'pending', toolCallId: 'call_1' },
    ]);
  });

  it('persists completed sibling tool results before pausing for HITL', async () => {
    const store = new FileSessionStore(root);
    const agent = new ReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core: new ReactCore({
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
                args: { query: 'context first' },
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
      }),
      ids: fixedIds(['task_1', 'msg_system', 'msg_user', 'msg_ai', 'msg_lookup', 'input_1']),
      clock: tickingClock(100),
    });

    const result = await agent.run({ sessionId: 'session_1', input: 'Draw cards with context' });

    expect(result.status).toBe('waiting_user_input');
    const messages = await store.listMessages('session_1');
    expect(messages).toMatchObject([
      { id: 'msg_system', role: 'system' },
      { id: 'msg_user', role: 'user' },
      {
        id: 'msg_ai',
        role: 'assistant',
        toolCalls: [
          { id: 'call_wait', name: 'choose_card' },
          { id: 'call_lookup', name: 'lookup' },
        ],
      },
      {
        id: 'msg_lookup',
        role: 'tool',
        content: 'lookup:context first',
        toolResult: {
          toolCallId: 'call_lookup',
          toolName: 'lookup',
        },
      },
    ]);
    await expect(store.listInputRequests('session_1')).resolves.toMatchObject([
      { id: 'input_1', toolCallId: 'call_wait', toolName: 'choose_card' },
    ]);
  });

  it('answers a tool input request as tool result and resumes the agent loop', async () => {
    const store = new FileSessionStore(root);
    let modelCalls = 0;
    const agent = new ReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core: new ReactCore({
        model: {
          invoke: async () => {
            modelCalls += 1;
            if (modelCalls === 1) {
              return new AIMessage({
                content: '',
                tool_calls: [{
                  id: 'call_1',
                  name: 'choose_card',
                  args: { count: 3 },
                  type: 'tool_call',
                }],
              });
            }
            return new AIMessage('The selected cards mean renewal.');
          },
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
      }),
      ids: fixedIds([
        'task_1',
        'msg_system',
        'msg_user',
        'msg_ai',
        'input_1',
        'msg_tool',
        'msg_final',
      ]),
      clock: tickingClock(100),
    });

    await agent.run({ sessionId: 'session_1', input: 'Draw cards' });
    const resumed = await agent.answerInputRequest({
      sessionId: 'session_1',
      requestId: 'input_1',
      value: { cards: ['A', 'B', 'C'] },
    });

    expect(resumed.status).toBe('completed');
    await expect(store.listTasks('session_1')).resolves.toMatchObject([
      { id: 'task_1', status: 'completed' },
    ]);
    const messages = await store.listMessages('session_1');
    expect(messages.map(message => message.id)).toEqual([
      'msg_system',
      'msg_user',
      'msg_ai',
      'msg_tool',
      'msg_final',
    ]);
    expect(messages[3]).toMatchObject({
      role: 'tool',
      toolResult: { toolCallId: 'call_1', toolName: 'choose_card' },
    });
    expect(messages[4]).toMatchObject({
      role: 'assistant',
      channel: 'final',
      content: 'The selected cards mean renewal.',
    });
  });

  it('waits for every pending input request before resuming the agent loop', async () => {
    const store = new FileSessionStore(root);
    let modelCalls = 0;
    const events: Array<{ type: string; operation?: string; result?: unknown }> = [];
    const agent = new ReactAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core: new ReactCore({
        model: {
          invoke: async () => {
            modelCalls += 1;
            if (modelCalls === 1) {
              return new AIMessage({
                content: '',
                tool_calls: [
                  {
                    id: 'call_cards',
                    name: 'choose_cards',
                    args: { count: 3 },
                    type: 'tool_call',
                  },
                  {
                    id: 'call_spread',
                    name: 'choose_spread',
                    args: {},
                    type: 'tool_call',
                  },
                ],
              });
            }
            return new AIMessage('Ready after both choices.');
          },
        },
        tools: [
          {
            name: 'choose_cards',
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
                prompt: 'Choose spread',
                input: { type: 'text' },
              },
            }),
          },
        ],
      }),
      ids: fixedIds([
        'task_1',
        'msg_system',
        'msg_user',
        'msg_ai',
        'input_cards',
        'input_spread',
        'msg_cards',
        'msg_spread',
        'msg_final',
      ]),
      clock: tickingClock(100),
      onEvent: async event => {
        events.push(event);
      },
    });

    const firstRun = await agent.run({ sessionId: 'session_1', input: 'Read my cards' });
    expect(firstRun).toMatchObject({
      status: 'waiting_user_input',
      waitingRequestIds: ['input_cards', 'input_spread'],
    });
    expect(modelCalls).toBe(1);

    const partialResume = await agent.answerInputRequest({
      sessionId: 'session_1',
      requestId: 'input_cards',
      value: { cards: ['A', 'B', 'C'] },
    });

    expect(partialResume).toMatchObject({
      status: 'waiting_user_input',
      waitingRequestIds: ['input_spread'],
    });
    expect(modelCalls).toBe(1);
    await expect(store.listTasks('session_1')).resolves.toMatchObject([
      { id: 'task_1', status: 'waiting_user_input', waitingRequestIds: ['input_spread'] },
    ]);

    const completed = await agent.answerInputRequest({
      sessionId: 'session_1',
      requestId: 'input_spread',
      value: { spread: 'past_present_future' },
    });

    expect(completed.status).toBe('completed');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: AgentSessionPatchType.TaskStatusChanged,
        task: expect.objectContaining({
          id: 'task_1',
          status: 'completed',
        }),
      }),
    ]));
    expect(modelCalls).toBe(2);
    const messages = await store.listMessages('session_1');
    expect(messages.map(message => message.id)).toEqual([
      'msg_system',
      'msg_user',
      'msg_ai',
      'msg_cards',
      'msg_spread',
      'msg_final',
    ]);
    expect(messages[3]).toMatchObject({
      role: 'tool',
      toolResult: { toolCallId: 'call_cards', toolName: 'choose_cards' },
    });
    expect(messages[4]).toMatchObject({
      role: 'tool',
      toolResult: { toolCallId: 'call_spread', toolName: 'choose_spread' },
    });
    expect(messages[5]).toMatchObject({
      role: 'assistant',
      channel: 'final',
      content: 'Ready after both choices.',
    });
  });

});

function fixedIds(values: string[]): (prefix: string) => string {
  const ids = [...values];
  return () => {
    const id = ids.shift();
    if (!id) {
      throw new Error('No fixed id left');
    }
    return id;
  };
}

function tickingClock(start: number): () => number {
  let current = start;
  return () => {
    current += 10;
    return current;
  };
}

class FakeCore extends ReactCore {
  constructor(private readonly events: CoreStepEvent[]) {
    const model: ReactCoreModel = {
      invoke: async () => {
        throw new Error('FakeCore does not invoke a model');
      },
    };
    super({ model, tools: [] });
  }

  override async *run(): AsyncIterable<CoreStepEvent> {
    yield* this.events;
  }
}
