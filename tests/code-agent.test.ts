import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextBuilder } from '../src/context/index.js';
import {
  CoreStepEventType,
  ReactCore,
  type CoreStepEvent,
  type ReactCoreModel,
  type ReactCoreToolContext,
} from '../src/core/index.js';
import { CodeAgent } from '../src/orchestration/index.js';
import { FileSessionStore } from '../src/storage/index.js';

describe('CodeAgent orchestration', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-code-agent-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a code project and runs a code task with project-scoped tool context', async () => {
    const store = new FileSessionStore(root);
    let receivedToolContext: ReactCoreToolContext | undefined;
    const core = new CapturingCore([
      {
        type: CoreStepEventType.ModelOutputCompleted,
        outputId: 'out_1',
        channel: 'final',
        content: 'done',
      },
    ], context => {
      receivedToolContext = context;
    });
    const agent = new CodeAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core,
      sandboxRoot: root,
      ids: fixedIds(['project_1', 'task_1', 'msg_system', 'msg_user', 'msg_assistant']),
      clock: tickingClock(100),
    });

    await expect(agent.run({
      sessionId: 'session_1',
      input: 'create a todo app',
      projectTitle: 'Todo App',
    })).resolves.toMatchObject({
      sessionId: 'session_1',
      taskId: 'task_1',
      projectId: 'project_1',
      status: 'completed',
    });

    await expect(store.getSession('session_1')).resolves.toMatchObject({ mode: 'code' });
    await expect(store.getCodeProject('project_1')).resolves.toMatchObject({
      id: 'project_1',
      sessionId: 'session_1',
      title: 'Todo App',
      sandboxRelativePath: 'code-projects/project_1',
    });
    await expect(store.listTasks('session_1')).resolves.toMatchObject([
      { id: 'task_1', kind: 'code', executor: 'code', metadata: { projectId: 'project_1' } },
    ]);
    await expect(store.listMessages('session_1')).resolves.toMatchObject([
      {
        id: 'msg_system',
        role: 'system',
        metadata: { kind: 'system_prompt', executor: 'code', promptVersion: 'code-v2' },
      },
      { id: 'msg_user', role: 'user', content: 'create a todo app' },
      { id: 'msg_assistant', role: 'assistant', content: 'done' },
    ]);
    expect(receivedToolContext).toMatchObject({
      sessionId: 'session_1',
      taskId: 'task_1',
      sandboxRoot: root,
      projectId: 'project_1',
    });
  });

  it('reuses the active code project for later runs in the same session', async () => {
    const store = new FileSessionStore(root);
    const agent = new CodeAgent({
      store,
      contextBuilder: new ContextBuilder(),
      core: new CapturingCore([
        {
          type: CoreStepEventType.ModelOutputCompleted,
          outputId: 'out_1',
          channel: 'final',
          content: 'done',
        },
      ], () => {}),
      sandboxRoot: root,
      ids: fixedIds([
        'project_1',
        'task_1',
        'msg_system_1',
        'msg_user_1',
        'msg_assistant_1',
        'task_2',
        'msg_system_2',
        'msg_user_2',
        'msg_assistant_2',
      ]),
      clock: tickingClock(100),
    });

    await agent.run({ sessionId: 'session_1', input: 'create a todo app' });
    const second = await agent.run({ sessionId: 'session_1', input: 'add filters' });

    expect(second.projectId).toBe('project_1');
    await expect(store.listCodeProjects('session_1')).resolves.toHaveLength(1);
    await expect(store.listTasks('session_1')).resolves.toMatchObject([
      { id: 'task_1', metadata: { projectId: 'project_1' } },
      { id: 'task_2', metadata: { projectId: 'project_1' } },
    ]);
  });
});

class CapturingCore extends ReactCore {
  constructor(
    private readonly events: CoreStepEvent[],
    private readonly onContext: (context?: ReactCoreToolContext) => void
  ) {
    const model: ReactCoreModel = {
      invoke: async () => {
        throw new Error('CapturingCore does not invoke a model');
      },
    };
    super({ model, tools: [] });
  }

  override async *run(input: {
    toolContext?: ReactCoreToolContext;
  }): AsyncIterable<CoreStepEvent> {
    this.onContext(input.toolContext);
    yield* this.events;
  }
}

function fixedIds(values: string[]): () => string {
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
