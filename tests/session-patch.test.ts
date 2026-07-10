import { describe, expect, it } from 'vitest';
import { CoreStepEventType } from '../src/core/index.js';
import {
  AgentSessionPatchType,
  type AgentSessionPatch,
} from '../src/domain/index.js';

describe('session patches', () => {
  it('represents tool-triggered input requirements', () => {
    expect(CoreStepEventType.ToolInputRequired).toBe('tool.input.required');
  });

  it('represents a persisted user message as a canonical UI event', () => {
    const patch: AgentSessionPatch = {
      type: AgentSessionPatchType.UserMessageCreated,
      sessionId: 'session_1',
      message: {
        id: 'msg_user',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 1,
        role: 'user',
        content: 'hello',
        createdAt: 1,
      },
    };

    expect(patch).toMatchObject({
      type: AgentSessionPatchType.UserMessageCreated,
      message: {
        taskId: 'task_1',
        id: 'msg_user',
        content: 'hello',
      },
    });
  });

  it('represents streaming as a session-scoped runtime event', () => {
    expect(AgentSessionPatchType.ModelOutputDelta).toBe('model.output.delta');
    expect({
      type: AgentSessionPatchType.ModelOutputDelta,
      sessionId: 'session_1',
      taskId: 'task_1',
      messageId: 'msg_1',
      outputId: 'output_1',
      channel: 'normal',
      delta: 'hel',
    }).toMatchObject({
      type: AgentSessionPatchType.ModelOutputDelta,
      taskId: 'task_1',
      messageId: 'msg_1',
      delta: 'hel',
    });
  });

  it('uses persisted messages as the completed output merge record', () => {
    const patch: AgentSessionPatch = {
      type: AgentSessionPatchType.ModelOutputCompleted,
      sessionId: 'session_1',
      outputId: 'output_1',
      message: {
        id: 'msg_1',
        sessionId: 'session_1',
        taskId: 'task_1',
        rowId: 2,
        role: 'assistant',
        channel: 'normal',
        content: 'hello',
        createdAt: 2,
      },
    };

    expect(patch.message.taskId).toBe('task_1');
    expect(patch.message.id).toBe('msg_1');
  });
});
