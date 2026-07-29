import { FatalToolExecutionError, type AgentLoop } from '../../loop/agent-loop.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../../loop/loop-events.js';
import { mapStoreError, RuntimeError } from '../../errors/runtime-error.js';
import { LoopEventHandler } from '../../events/loop-event-handler.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import type { ReActTaskExecutionResult, ReActLoopExecutionInput } from '../types/react-execution.types.js';

interface DurableLoopExecutionOptions {
  loop: AgentLoop;
  eventHandler: LoopEventHandler;
  store: AgentStore;
  ownerId: string;
  clock: { nowMs(): number };
  input: ReActLoopExecutionInput;
}

export async function executeDurableAgentLoop(
  options: DurableLoopExecutionOptions
): Promise<ReActTaskExecutionResult> {
  const { input, loop, eventHandler } = options;
  const target = {
    sessionId: input.task.sessionId,
    taskId: input.task.id,
    taskRunId: input.taskRun.id,
  };
  let finalEvent: Extract<LoopEvent, {
    type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted;
  }> | undefined;
  const inputRequiredEvents: Array<Extract<LoopEvent, {
    type: typeof LOOP_EVENT_TYPES.ToolInputRequired;
  }>> = [];
  const iterator = loop.run({ ...input.loopInput, target });

  while (true) {
    let next;
    try {
      next = await iterator.next();
    } catch (error) {
      const failed = await handleLoopError(error, input, options);
      if (failed) return failed;
      throw error;
    }
    if (!next.done) {
      const event = next.value;
      const feedback = await eventHandler.handle(event, target);
      if (event.type === LOOP_EVENT_TYPES.ModelOutputCompleted && event.toolCalls.length === 0) {
        // AgentLoop emits one final model event immediately before returning completed.
        finalEvent = event;
      } else if (event.type === LOOP_EVENT_TYPES.ToolInputRequired) {
        inputRequiredEvents.push(event);
      }
      if (feedback?.stopTask) {
        await iterator.return({
          type: 'failed',
          ...feedback.stopTask,
        });
        return failTask(options, input, feedback.stopTask);
      }
      continue;
    }

    const result = next.value;
    if (result.type === 'completed') {
      if (!finalEvent || finalEvent.outputId !== result.outputId || finalEvent.content !== result.content) {
        return failTask(options, input, {
          code: 'model_protocol_error',
          message: 'AgentLoop completed without a matching final model event.',
        });
      }
      const committed = await eventHandler.completeFinal(finalEvent, target);
      return { type: 'completed', ...committed };
    }
    if (result.type === 'waiting_for_user') {
      const receivedIds = inputRequiredEvents.map(event => event.modelToolCallId).sort();
      const resultIds = [...result.modelToolCallIds].sort();
      if (JSON.stringify(receivedIds) !== JSON.stringify(resultIds)) {
        return failTask(options, input, {
          code: 'model_protocol_error',
          message: 'AgentLoop input events do not match its waiting result.',
        });
      }
      const waiting = await eventHandler.markWaitingForInput(inputRequiredEvents, target);
      return { type: 'waiting_for_user', task: waiting.task, requests: waiting.requests };
    }
    if (result.type === 'cancelled') return completeCancellation(input, result.reason, options);
    return failTask(options, input, {
      code: result.code,
      message: result.message,
      details: result.details,
    });
  }
}

async function handleLoopError(
  error: unknown,
  input: ReActLoopExecutionInput,
  options: DurableLoopExecutionOptions
): Promise<Extract<ReActTaskExecutionResult, { type: 'failed' }> | undefined> {
  if (error instanceof FatalToolExecutionError) {
    if (['ownership_lost', 'concurrency_conflict'].includes(error.code)) {
      throw new RuntimeError(error.code as 'ownership_lost' | 'concurrency_conflict', error.message, { cause: error });
    }
    return failTask(options, input, { code: error.code, message: error.message });
  }
  if (error instanceof RuntimeError) {
    if (['ownership_lost', 'concurrency_conflict'].includes(error.code)) throw error;
    return failTask(options, input, { code: error.code, message: error.message, details: error.details });
  }
  return undefined;
}

async function completeCancellation(
  input: ReActLoopExecutionInput,
  reason: 'runtime_shutdown' | 'ownership_lost' | undefined,
  options: DurableLoopExecutionOptions
): Promise<Extract<ReActTaskExecutionResult, { type: 'cancelled' }>> {
  if (reason) {
    if (reason === 'ownership_lost') {
      throw new RuntimeError(
        'ownership_lost',
        `TaskRun ${JSON.stringify(input.taskRun.id)} lost its execution lease.`
      );
    }
    throw new RuntimeError(
      'aborted',
      `Task ${JSON.stringify(input.task.id)} was interrupted by shutdown.`
    );
  }
  const current = await options.store.tasks.get(input.task.id);
  if (!current) throw new RuntimeError('storage_error', `Task ${JSON.stringify(input.task.id)} disappeared.`);
  if (current.status === 'cancelled') return { type: 'cancelled', task: current };
  const cancelled = await options.store.tasks.cancel({
    taskId: current.id,
    expectedTaskVersion: current.version,
    nowMs: options.clock.nowMs(),
  }).catch(error => { throw mapStoreError(error); });
  await options.eventHandler.publishTaskFinish(cancelled);
  return { type: 'cancelled', task: cancelled.task };
}

async function failTask(
  options: DurableLoopExecutionOptions,
  input: ReActLoopExecutionInput,
  failure: { code: string; message: string; details?: unknown }
): Promise<Extract<ReActTaskExecutionResult, { type: 'failed' }>> {
  const failed = await options.store.tasks.fail({
    taskId: input.task.id,
    expectedTaskVersion: input.task.version,
    taskRunId: input.taskRun.id,
    ownerId: options.ownerId,
    error: failure,
    nowMs: options.clock.nowMs(),
  }).catch(error => { throw mapStoreError(error); });
  await options.eventHandler.publishTaskFinish(failed);
  return { type: 'failed', task: failed.task };
}
