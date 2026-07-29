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

  it('stops the loop when the handler reports a side-effect confirmation request', async () => {
    const activeTask = task('running');
    const activeRun = taskRun();
    const waitingTask = task('waiting_for_user');
    const request = { id: 'input_1' } as never;
    const event = {
      type: LOOP_EVENT_TYPES.ToolResultFailed,
      modelToolCallId: 'model_tool_call_1',
      toolName: 'run_shell',
      executionStarted: true,
      code: 'tool_state_unknown',
      message: 'Outcome unknown.',
      durationMs: 5,
    } satisfies LoopEvent;
    const iterator = asyncIterator([{ done: false as const, value: event }]);
    const handle = vi.fn(async () => ({
      waitingForUser: { task: waitingTask, requests: [request] },
    }));

    const result = await executeDurableAgentLoop({
      loop: { run: vi.fn(() => iterator) } as never,
      eventHandler: { handle } as never,
      store: {} as AgentStore,
      ownerId: 'worker_1',
      clock: { nowMs: () => 100 },
      input: { task: activeTask, taskRun: activeRun, loopInput: {} as never },
    });

    expect(iterator.return).toHaveBeenCalledWith({
      type: 'failed',
      code: 'tool_state_unknown',
      message: 'A side-effecting tool outcome is unknown and requires user confirmation.',
    });
    expect(iterator.next).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      type: 'waiting_for_user',
      task: waitingTask,
      requests: [request],
    });
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
