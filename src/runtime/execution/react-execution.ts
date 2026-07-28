import { randomUUID } from 'node:crypto';
import { AgentLoop } from '../loop/agent-loop.js';
import type { AgentJob } from '../../domain/index.js';
import { AuditedModelFactory } from '../model/audited-model.factory.js';
import { executeDurableAgentLoop } from './helpers/durable-loop-execution.helper.js';
import type {
  JobActionsPort,
  ReActJobExecutionResult,
} from './types/react-execution.types.js';
import type { BuiltContext } from '../context/types/context.types.js';
import type { ReActContextService } from '../context/react-context.service.js';
import {
  RuntimeEventWriter,
  type RuntimeEventPublisher,
} from '../events/runtime-event-writer.js';
import { ToolExecutor, type RuntimeTool } from './tool-executor.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { FinalAnswerPolicy } from './policies/final-answer-policy.js';
import { ToolCallPolicy } from './policies/tool-call-policy.js';
import { PendingToolCallLoader } from './recovery/pending-tool-call-loader.js';

export interface ReActExecutionOptions {
  store: AgentStore;
  jobActions: JobActionsPort;
  context: Pick<ReActContextService, 'buildForJob'>;
  workerId: string;
  publisher: RuntimeEventPublisher;
  modelFactory: AuditedModelFactory;
  tools: RuntimeTool[];
  sandboxRoot?: string;
  maxIterations: number;
  maxToolCalls: number;
  executionDeadlineMs: number;
  streaming: boolean;
}

/**
 * Executes one durable Job through one ReAct loop. Every model turn reloads
 * the canonical database context, so tool calls, plan updates and HITL answers
 * become visible without a nested executor or an in-memory context fork.
 */
export class ReActExecution {
  readonly #toolCallPolicy: ToolCallPolicy;
  readonly #finalAnswerPolicy: FinalAnswerPolicy;
  readonly #pendingToolCallLoader: PendingToolCallLoader;

  constructor(private readonly options: ReActExecutionOptions) {
    this.#toolCallPolicy = new ToolCallPolicy(options.tools);
    this.#finalAnswerPolicy = new FinalAnswerPolicy(options.store);
    this.#pendingToolCallLoader = new PendingToolCallLoader(options.store);
  }

  async runJob(input: {
    job: AgentJob;
    signal?: AbortSignal;
  }): Promise<ReActJobExecutionResult> {
    const checkpoint = await this.options.store.execution.getLatestLoopCheckpoint(input.job.id);
    const pendingToolCalls = await this.#pendingToolCallLoader.load(
      input.job,
      checkpoint?.callMessageId
    );
    let current: BuiltContext | undefined;
    const toolExecutor = this.#toolExecutor();
    const tools = toolExecutor.tools();
    const resume = checkpoint ? {
      iterationNo: checkpoint.iterationNo,
      executedToolCalls: checkpoint.executedToolCalls,
      pendingToolCalls,
    } : undefined;
    return executeDurableAgentLoop({
      loop: new AgentLoop({
        model: this.options.modelFactory.create({
          job: input.job,
          manifest: () => {
            if (!current) throw new Error('Model context is unavailable before tool recovery completes.');
            return current.inputManifest;
          },
          callType: 'job.react',
          logicalCallKey: 'job.react',
          tools,
        }),
        createOutputId,
        streaming: this.options.streaming,
      }),
      writer: this.#writer(),
      jobActions: this.options.jobActions,
      input: {
        job: input.job,
        loopInput: {
          context: {
            loadMessages: async () => {
              current = await this.options.context.buildForJob(input.job);
              return current.messages;
            },
          },
          tools: {
            definitions: tools,
            executor: toolExecutor,
            exclusiveNames: new Set(
              this.options.tools.filter(tool => tool.exclusive).map(tool => tool.tool.name)
            ),
          },
          policy: {
            validateToolCalls: candidate => this.#toolCallPolicy.validate(candidate.toolCalls),
            validateFinalAnswer: () => this.#finalAnswerPolicy.validate(input.job.id),
          },
          limits: this.#limits(input.job, input.signal),
          ...(resume ? { resume } : {}),
        },
      },
    });
  }

  #toolExecutor(): ToolExecutor {
    return new ToolExecutor({
      store: this.options.store,
      workerId: this.options.workerId,
      tools: this.options.tools,
      sandboxRoot: this.options.sandboxRoot,
    });
  }

  #writer(): RuntimeEventWriter {
    return new RuntimeEventWriter({
      store: this.options.store,
      workerId: this.options.workerId,
      tools: this.options.tools,
      publisher: this.options.publisher,
      requireModelCallAudit: true,
    });
  }

  #limits(job: AgentJob, signal?: AbortSignal) {
    return {
      maxIterations: this.options.maxIterations,
      maxToolCalls: this.options.maxToolCalls,
      deadlineMs: (job.startedAtMs ?? Date.now()) + this.options.executionDeadlineMs,
      signal,
    };
  }

}

function createOutputId(): string {
  return `output_${randomUUID()}`;
}
