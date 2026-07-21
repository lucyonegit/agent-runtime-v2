import type { BaseMessage } from '@langchain/core/messages';
import {
  AgentLoop,
  FatalToolExecutionError,
  type AgentLoopLimits,
  type ToolExecutorPort,
} from '../agent-loop/agent-loop.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../agent-loop/loop-events.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type {
  AgentJob,
  AgentMessage,
  AgentUserInputRequest,
} from '../domain/index.js';
import { JobCoordinator } from '../orchestration/lifecycle/job-coordinator.js';
import { RuntimeError } from './runtime-errors.js';
import { RuntimeEventWriter } from './runtime-event-writer.js';

export interface JobAgentRunInput {
  job: AgentJob;
  messages: BaseMessage[];
  prepareMessages?: (iteration: number) => Promise<BaseMessage[]>;
  tools: StructuredToolInterface[];
  exclusiveToolNames?: ReadonlySet<string>;
  validateToolCalls?: Parameters<AgentLoop['run']>[0]['validateToolCalls'];
  validateFinalAnswer?: Parameters<AgentLoop['run']>[0]['validateFinalAnswer'];
  toolExecutor: ToolExecutorPort;
  outputIdFactory: () => string;
  limits: AgentLoopLimits;
}

export type JobAgentRunResult =
  | { type: 'completed'; job: AgentJob; message: AgentMessage }
  | { type: 'waiting_user_input'; job: AgentJob; requests: AgentUserInputRequest[] }
  | { type: 'failed'; job: AgentJob }
  | { type: 'cancelled'; job: AgentJob };

export interface AgentRunnerOptions {
  loop: AgentLoop;
  writer: RuntimeEventWriter;
  coordinator: JobCoordinator;
}

export class AgentRunner {
  readonly #loop: AgentLoop;
  readonly #writer: RuntimeEventWriter;
  readonly #coordinator: JobCoordinator;

  constructor(options: AgentRunnerOptions) {
    this.#loop = options.loop;
    this.#writer = options.writer;
    this.#coordinator = options.coordinator;
  }

  async runJob(input: JobAgentRunInput): Promise<JobAgentRunResult> {
    if (!input.job.currentAttemptId || !input.job.leaseOwner) {
      throw new RuntimeError('lease_lost', `Job ${JSON.stringify(input.job.id)} has no active execution attempt.`);
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
    const iterator = this.#loop.run({
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
    });

    while (true) {
      let next;
      try {
        next = await iterator.next();
      } catch (error) {
        if (error instanceof FatalToolExecutionError) {
          if (error.code === 'lease_lost' || error.code === 'concurrency_conflict') {
            throw new RuntimeError(error.code, error.message, { cause: error });
          }
          const failed = await this.#coordinator.failJob(input.job, {
            code: error.code,
            message: error.message,
          });
          return { type: 'failed', job: failed };
        }
        if (error instanceof RuntimeError) {
          if (error.code === 'lease_lost' || error.code === 'concurrency_conflict') throw error;
          const failed = await this.#coordinator.failJob(input.job, {
            code: error.code,
            message: error.message,
            details: error.details,
          });
          return { type: 'failed', job: failed };
        }
        throw error;
      }

      if (!next.done) {
        const recorded = await this.#writer.record(next.value, target);
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
          const failed = await this.#coordinator.failJob(input.job, {
            code: 'model_protocol_error',
            message: 'AgentLoop completed without a matching final model event.',
          });
          return { type: 'failed', job: failed };
        }
        const committed = await this.#writer.completeFinal(finalEvent, target);
        return { type: 'completed', ...committed };
      }
      if (result.type === 'waiting_user_input') {
        const receivedIds = inputEvents.map(event => event.toolCallId).sort();
        const resultIds = [...result.toolCallIds].sort();
        if (JSON.stringify(receivedIds) !== JSON.stringify(resultIds)) {
          const failed = await this.#coordinator.failJob(input.job, {
            code: 'model_protocol_error',
            message: 'AgentLoop input events do not match its waiting result.',
          });
          return { type: 'failed', job: failed };
        }
        const waiting = await this.#writer.markWaitingForInput(inputEvents, target);
        return {
          type: 'waiting_user_input',
          job: waiting.job,
          requests: waiting.requests,
        };
      }
      if (result.type === 'cancelled') {
        if (result.reason === 'runtime_shutdown') {
          throw new RuntimeError('aborted', `Job ${JSON.stringify(input.job.id)} execution was interrupted by Runtime shutdown.`);
        }
        const current = await this.#coordinator.getJob(input.job.id);
        if (!current) {
          throw new RuntimeError('storage_error', `Job ${JSON.stringify(input.job.id)} disappeared during cancellation.`);
        }
        if (current.status === 'cancelled') return { type: 'cancelled', job: current };
        if (!['created', 'running', 'waiting_user_input', 'resuming'].includes(current.status)) {
          throw new RuntimeError(
            'lease_lost',
            `Job ${JSON.stringify(input.job.id)} became ${current.status} during cancellation.`
          );
        }
        const cancelled = await this.#coordinator.cancelJob(current.id, current.version);
        return { type: 'cancelled', job: cancelled };
      }
      const failed = await this.#coordinator.failJob(input.job, {
        code: result.code,
        message: result.message,
        details: result.details,
      });
      return { type: 'failed', job: failed };
    }
  }
}
