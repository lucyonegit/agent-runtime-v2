import type { BaseMessage } from '@langchain/core/messages';
import {
  AgentLoop,
  FatalToolExecutionError,
  type AgentLoopLimits,
  type ToolExecutorPort,
} from '../agent-loop/agent-loop.js';
import { LOOP_EVENT_TYPES, type LoopEvent } from '../agent-loop/loop-events.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentJob, AgentStepRun } from '../domain/index.js';
import type { AgentStore } from '../storage/agent-store.js';
import { RuntimeError } from '../runtime/runtime-errors.js';
import { RuntimeEventWriter } from '../runtime/runtime-event-writer.js';
import { parseStepOutput, StepOutputValidationError, type StepOutputV1 } from './step-output.js';

export interface StepOutputRepairPort {
  repair(input: { rawOutput: string; issues: string[] }): Promise<string | unknown>;
}

export interface StepRunnerOptions {
  loop: AgentLoop;
  writer: RuntimeEventWriter;
  store: AgentStore;
  repair?: StepOutputRepairPort;
  maxStepRunsPerStep?: number;
}

export type StepRunnerResult =
  | { type: 'completed'; output: StepOutputV1; job: AgentJob }
  | { type: 'waiting_user_input'; job: AgentJob }
  | { type: 'failed'; job: AgentJob; retryStep: boolean };

export class StepRunner {
  readonly #loop: AgentLoop;
  readonly #writer: RuntimeEventWriter;
  readonly #store: AgentStore;
  readonly #repair?: StepOutputRepairPort;
  readonly #maxStepRunsPerStep: number;

  constructor(options: StepRunnerOptions) {
    this.#loop = options.loop;
    this.#writer = options.writer;
    this.#store = options.store;
    this.#repair = options.repair;
    this.#maxStepRunsPerStep = options.maxStepRunsPerStep ?? 2;
  }

  async run(input: {
    job: AgentJob;
    stepRun: AgentStepRun;
    messages: BaseMessage[];
    tools: StructuredToolInterface[];
    toolExecutor: ToolExecutorPort;
    outputIdFactory: () => string;
    limits: AgentLoopLimits;
  }): Promise<StepRunnerResult> {
    const attemptId = input.job.currentAttemptId;
    if (!attemptId || input.stepRun.currentAttemptId !== attemptId) {
      throw new RuntimeError('lease_lost', 'StepRun does not belong to the current Job attempt.');
    }
    const target = {
      sessionId: input.job.sessionId,
      jobId: input.job.id,
      projectId: input.job.projectId,
      stepRunId: input.stepRun.id,
      attemptId,
    };
    const finals = new Map<string, Extract<LoopEvent, {
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
    });
    while (true) {
      let next;
      try {
        next = await iterator.next();
      } catch (error) {
        if (error instanceof FatalToolExecutionError
          && (error.code === 'lease_lost' || error.code === 'concurrency_conflict')) {
          throw new RuntimeError(error.code, error.message, { cause: error });
        }
        return this.#fail(target, input.stepRun, {
          code: error instanceof FatalToolExecutionError ? error.code : 'step_execution_failed',
          message: error instanceof Error ? error.message : 'Step execution failed.',
        });
      }
      if (!next.done) {
        const recorded = await this.#writer.record(next.value, target);
        if (recorded.type === 'final_candidate') finals.set(recorded.event.outputId, recorded.event);
        if (recorded.type === 'input_required') inputEvents.push(recorded.event);
        continue;
      }
      const result = next.value;
      if (result.type === 'waiting_user_input') {
        const waiting = await this.#writer.markWaitingForInput(inputEvents, target);
        return { type: 'waiting_user_input', job: waiting.job };
      }
      if (result.type !== 'completed') {
        return this.#fail(target, input.stepRun, {
          code: result.type === 'failed' ? result.code : 'aborted',
          message: result.type === 'failed' ? result.message : 'Step execution was cancelled.',
          ...(result.type === 'failed' ? { details: result.details } : {}),
        });
      }
      const finalEvent = finals.get(result.outputId);
      if (!finalEvent) {
        return this.#fail(target, input.stepRun, {
          code: 'invalid_step_output',
          message: 'Step completed without a final output event.',
        });
      }
      let output: StepOutputV1;
      try {
        output = parseStepOutput(finalEvent.content);
        await this.#validateEvidence(input.job.id, input.stepRun.id, output);
      } catch (error) {
        if (!(error instanceof StepOutputValidationError) || !this.#repair) {
          return this.#fail(target, input.stepRun, normalizeValidationError(error));
        }
        try {
          output = parseStepOutput(await this.#repair.repair({
            rawOutput: finalEvent.content,
            issues: error.issues,
          }));
          await this.#validateEvidence(input.job.id, input.stepRun.id, output);
        } catch (repairError) {
          return this.#fail(target, input.stepRun, normalizeValidationError(repairError));
        }
      }
      const committed = await this.#writer.commitStepOutput(finalEvent, target, output);
      return { type: 'completed', output, job: committed.job };
    }
  }

  async #validateEvidence(jobId: string, stepRunId: string, output: StepOutputV1): Promise<void> {
    const messages = await this.#store.listSessionMessages(
      (await this.#store.getJob(jobId))?.sessionId ?? ''
    );
    const allowed = new Set(messages
      .filter(message => message.jobId === jobId && message.stepRunId === stepRunId)
      .map(message => message.id));
    const invalid = output.evidence.flatMap(evidence => evidence.sourceMessageIds)
      .filter(id => !allowed.has(id));
    if (invalid.length > 0) {
      throw new StepOutputValidationError([`evidence references messages outside current StepRun: ${invalid.join(',')}`]);
    }
  }

  async #fail(
    target: { sessionId: string; jobId: string; stepRunId: string; attemptId: string },
    stepRun: AgentStepRun,
    error: { code: string; message: string; details?: unknown }
  ): Promise<StepRunnerResult> {
    const retryStep = stepRun.runNo < this.#maxStepRunsPerStep;
    const failed = await this.#writer.failStepRun(target, error, retryStep);
    return { type: 'failed', job: failed.job, retryStep };
  }
}

function normalizeValidationError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof StepOutputValidationError) {
    return { code: error.code, message: error.message, details: { issues: error.issues } };
  }
  return {
    code: 'invalid_step_output',
    message: error instanceof Error ? error.message : 'Invalid StepOutput.',
  };
}
