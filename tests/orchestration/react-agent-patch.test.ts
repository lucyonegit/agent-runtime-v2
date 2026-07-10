import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ContextBuilder } from '../../src/context/index.js';
import { CoreStepEventType, type ReactCore } from '../../src/core/index.js';
import { AgentSessionPatchType, type AgentSessionPatch } from '../../src/domain/index.js';
import { ReactAgent } from '../../src/orchestration/index.js';
import { FileSessionStore } from '../../src/storage/index.js';

describe('ReactAgent session patches', () => {
  it('emits canonical persisted records for messages and tasks', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agent-runtime-v2-'));
    try {
      const store = new FileSessionStore(rootDir);
      const patches: AgentSessionPatch[] = [];
      let idSeq = 0;
      let now = 1000;
      const core = {
        async *run() {
          yield {
            type: CoreStepEventType.ModelOutputCompleted,
            outputId: 'output_1',
            channel: 'final',
            content: 'hello from agent',
          };
        },
      } as unknown as ReactCore;

      const agent = new ReactAgent({
        store,
        contextBuilder: new ContextBuilder(),
        core,
        ids: prefix => `${prefix}_${++idSeq}`,
        clock: () => now++,
        onEvent: patch => {
          patches.push(patch);
        },
      });

      await agent.run({ sessionId: 'session_a', input: 'hello' });

      const userPatch = patches.find(patch => patch.type === AgentSessionPatchType.UserMessageCreated) as any;
      expect(userPatch.message).toMatchObject({
        id: 'msg_3',
        sessionId: 'session_a',
        taskId: 'task_1',
        rowId: 2,
        role: 'user',
        content: 'hello',
      });

      const modelPatch = patches.find(patch => patch.type === AgentSessionPatchType.ModelOutputCompleted) as any;
      expect(modelPatch.message).toMatchObject({
        id: 'msg_4',
        sessionId: 'session_a',
        taskId: 'task_1',
        rowId: 3,
        role: 'assistant',
        channel: 'final',
        content: 'hello from agent',
      });

      const completedTaskPatch = patches.find(
        patch => patch.type === AgentSessionPatchType.TaskStatusChanged && (patch as any).task?.status === 'completed'
      ) as any;
      expect(completedTaskPatch.task).toMatchObject({
        id: 'task_1',
        sessionId: 'session_a',
        kind: 'react',
        executor: 'react',
        status: 'completed',
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
