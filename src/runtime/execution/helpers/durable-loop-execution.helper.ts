import {
  FatalToolExecutionError,
  type AgentLoop,
} from '../../loop/agent-loop.js';
import {
  LOOP_EVENT_TYPES,
  type LoopEvent,
} from '../../loop/loop-events.js';
import { RuntimeError } from '../../errors/runtime-error.js';
import { RuntimeEventWriter } from '../../events/runtime-event-writer.js';
import type {
  JobExecutionStatePort,
  ReactJobExecutionResult,
  ReactLoopExecutionInput,
} from '../types/react-execution.types.js';

interface DurableLoopExecutionOptions {
  loop: AgentLoop;
  writer: RuntimeEventWriter;
  jobState: JobExecutionStatePort;
  input: ReactLoopExecutionInput;
}

export async function executeDurableAgentLoop(
  options: DurableLoopExecutionOptions
): Promise<ReactJobExecutionResult> {
  const { input, loop, writer, jobState } = options;
  if (!input.job.currentAttemptId || !input.job.leaseOwner) {
    throw new RuntimeError(
      'lease_lost',
      `Job ${JSON.stringify(input.job.id)} has no active execution attempt.`
    );
  }
  const target = {
    sessionId: input.job.sessionId,
    jobId: input.job.id,
    attemptId: input.job.currentAttemptId,
  };
  const finalCandidates = new Map<string, Extract<LoopEvent, {
    type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted;
  }>>();
  const inputEvents: Array<Extract<LoopEvent, {
    type: typeof LOOP_EVENT_TYPES.ToolInputRequired;
  }>> = [];
  const iterator = loop.run({
    messages: input.messages,
    target,
    tools: input.tools,
    toolExecutor: input.toolExecutor,
    outputIdFactory: input.outputIdFactory,
    limits: input.limits,
    prepareMessages: input.prepareMessages,
    exclusiveToolNames: input.exclusiveToolNames,
    validateToolCalls: input.validateToolCalls,
    validateFinalAnswer: input.validateFinalAnswer,
    initialIterationNo: input.initialIterationNo,
    initialExecutedToolCalls: input.initialExecutedToolCalls,
    resumeToolCalls: input.resumeToolCalls,
  });

  while (true) {
    let next;
    try {
      next = await iterator.next();
    } catch (error) {
      const failed = await handleLoopError(error, input, jobState);
      if (failed) return failed;
      throw error;
    }

    if (!next.done) {
      const recorded = await writer.record(next.value, target);
      if (recorded.type === 'final_candidate') {
        finalCandidates.set(recorded.event.outputId, recorded.event);
      } else if (recorded.type === 'input_required') {
        inputEvents.push(recorded.event);
      }
      continue;
    }

    const result = next.value;
    if (result.type === 'completed') {
      const finalEvent = finalCandidates.get(result.outputId);
      if (!finalEvent || finalEvent.content !== result.content) {
        return failJob(jobState, input, {
          code: 'model_protocol_error',
          message: 'AgentLoop completed without a matching final model event.',
        });
      }
      const committed = await writer.completeFinal(finalEvent, target);
      return { type: 'completed', ...committed };
    }
    if (result.type === 'waiting_user_input') {
      const receivedIds = inputEvents.map(event => event.toolCallId).sort();
      const resultIds = [...result.toolCallIds].sort();
      if (JSON.stringify(receivedIds) !== JSON.stringify(resultIds)) {
        return failJob(jobState, input, {
          code: 'model_protocol_error',
          message: 'AgentLoop input events do not match its waiting result.',
        });
      }
      const waiting = await writer.markWaitingForInput(inputEvents, target);
      return {
        type: 'waiting_user_input',
        job: waiting.job,
        requests: waiting.requests,
      };
    }
    if (result.type === 'cancelled') {
      return completeCancellation(input, result.reason, jobState);
    }
    return failJob(jobState, input, {
      code: result.code,
      message: result.message,
      details: result.details,
    });
  }
}

async function handleLoopError(
  error: unknown,
  input: ReactLoopExecutionInput,
  jobState: JobExecutionStatePort
): Promise<Extract<ReactJobExecutionResult, { type: 'failed' }> | undefined> {
  if (error instanceof FatalToolExecutionError) {
    if (error.code === 'lease_lost' || error.code === 'concurrency_conflict') {
      throw new RuntimeError(error.code, error.message, { cause: error });
    }
    return failJob(jobState, input, {
      code: error.code,
      message: error.message,
    });
  }
  if (error instanceof RuntimeError) {
    if (error.code === 'lease_lost' || error.code === 'concurrency_conflict') throw error;
    return failJob(jobState, input, {
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }
  return undefined;
}

async function completeCancellation(
  input: ReactLoopExecutionInput,
  reason: 'runtime_shutdown' | undefined,
  jobState: JobExecutionStatePort
): Promise<Extract<ReactJobExecutionResult, { type: 'cancelled' }>> {
  if (reason === 'runtime_shutdown') {
    throw new RuntimeError(
      'aborted',
      `Job ${JSON.stringify(input.job.id)} execution was interrupted by Runtime shutdown.`
    );
  }
  const current = await jobState.getJob(input.job.id);
  if (!current) {
    throw new RuntimeError(
      'storage_error',
      `Job ${JSON.stringify(input.job.id)} disappeared during cancellation.`
    );
  }
  if (current.status === 'cancelled') return { type: 'cancelled', job: current };
  if (!['created', 'running', 'waiting_user_input', 'resuming'].includes(current.status)) {
    throw new RuntimeError(
      'lease_lost',
      `Job ${JSON.stringify(input.job.id)} became ${current.status} during cancellation.`
    );
  }
  const cancelled = await jobState.cancelJob(current.id, current.version);
  return { type: 'cancelled', job: cancelled };
}

async function failJob(
  jobState: JobExecutionStatePort,
  input: ReactLoopExecutionInput,
  failure: {
    code: string;
    message: string;
    details?: unknown;
  }
): Promise<Extract<ReactJobExecutionResult, { type: 'failed' }>> {
  const failed = await jobState.failJob(input.job, failure);
  return { type: 'failed', job: failed };
}
