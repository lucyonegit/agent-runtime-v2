import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentTask, AgentTaskRun } from '../src/domain/index.js';
import { executeDurableAgentLoop } from '../src/runtime/execution/helpers/durable-loop-execution.helper.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../src/runtime/loop/loop-events.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('executeDurableAgentLoop event boundary', () => {
  it('derives final control state from the emitted LoopEvent, not handler bookkeeping', async () => {
    const activeTask = task('running');
    const activeRun = taskRun();
    const completedTask = task('completed');
    const message = { id: 'message_1', sessionId: activeTask.sessionId } as AgentMessage;
    const event = {
      type: LOOP_EVENT_TYPES.ModelOutputCompleted,
      outputId: 'output_1',
      content: 'done',
      toolCalls: [],
    } satisfies LoopEvent;
    const iterator = asyncIterator([
      { done: false as const, value: event },
      {
        done: true as const,
        value: { type: 'completed' as const, outputId: event.outputId, content: event.content },
      },
    ]);
    const handle = vi.fn(async () => undefined);
    const completeFinal = vi.fn(async () => ({ task: completedTask, message }));

    const result = await executeDurableAgentLoop({
      loop: { run: vi.fn(() => iterator) } as never,
      eventHandler: { handle, completeFinal } as never,
      store: {} as AgentStore,
      ownerId: 'worker_1',
      clock: { nowMs: () => 100 },
      input: { task: activeTask, taskRun: activeRun, loopInput: {} as never },
    });

    expect(handle).toHaveBeenCalledWith(event, {
      sessionId: activeTask.sessionId,
      taskId: activeTask.id,
      taskRunId: activeRun.id,
    });
    expect(completeFinal).toHaveBeenCalledWith(event, expect.any(Object));
    expect(result).toEqual({ type: 'completed', task: completedTask, message });
  });

  it('fails the Task when the handler reports an unknown side-effect outcome', async () => {
    const activeTask = task('running');
    const activeRun = taskRun();
    const failedTask = task('failed');
    const event = {
      type: LOOP_EVENT_TYPES.ToolResultFailed,
      modelToolCallId: 'model_tool_call_1',
      toolName: 'run_shell',
      executionStarted: true,
      outcomeUnknown: true,
      code: 'tool_state_unknown',
      message: 'Outcome unknown.',
      durationMs: 5,
    } satisfies LoopEvent;
    const iterator = asyncIterator([{ done: false as const, value: event }]);
    const handle = vi.fn(async () => ({
      stopTask: {
        code: 'tool_state_unknown' as const,
        message: 'Outcome unknown.',
        details: { toolCallId: 'tool_call_1' },
      },
    }));
    const fail = vi.fn(async () => ({
      task: failedTask,
      taskRun: activeRun,
      toolCalls: [],
      userInputRequests: [],
      planCleared: false,
    }));
    const publishTaskFinish = vi.fn(async () => undefined);

    const result = await executeDurableAgentLoop({
      loop: { run: vi.fn(() => iterator) } as never,
      eventHandler: { handle, publishTaskFinish } as never,
      store: { tasks: { fail } } as unknown as AgentStore,
      ownerId: 'worker_1',
      clock: { nowMs: () => 100 },
      input: { task: activeTask, taskRun: activeRun, loopInput: {} as never },
    });

    expect(iterator.return).toHaveBeenCalledWith({
      type: 'failed',
      code: 'tool_state_unknown',
      message: 'Outcome unknown.',
      details: { toolCallId: 'tool_call_1' },
    });
    expect(iterator.next).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith({
      taskId: activeTask.id,
      expectedTaskVersion: activeTask.version,
      taskRunId: activeRun.id,
      ownerId: 'worker_1',
      error: {
        code: 'tool_state_unknown',
        message: 'Outcome unknown.',
        details: { toolCallId: 'tool_call_1' },
      },
      nowMs: 100,
    });
    expect(result).toEqual({ type: 'failed', task: failedTask });
  });
});

function asyncIterator(steps: Array<IteratorResult<LoopEvent, unknown>>) {
  return {
    next: vi.fn(async () => steps.shift() ?? ({
      done: true as const,
      value: { type: 'failed', code: 'empty_model_output', message: 'No result.' },
    })),
    return: vi.fn(async (value: unknown) => ({ done: true as const, value })),
  };
}

function task(status: AgentTask['status']): AgentTask {
  return {
    id: 'task_1',
    sessionId: 'session_1',
    goalMessageId: 'goal_1',
    status,
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function taskRun(): AgentTaskRun {
  return {
    id: 'task_run_1',
    taskId: 'task_1',
    runNo: 1,
    trigger: 'initial',
    status: 'running',
    ownerId: 'worker_1',
    ownershipExpiresAtMs: 1_000,
    startedAtMs: 1,
    updatedAtMs: 1,
  };
}
