import { randomUUID } from 'node:crypto';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { AgentLoop } from '../loop/agent-loop.js';
import type { AgentContextInputManifest, AgentJob, AgentModelCallType } from '../../domain/index.js';
import { AuditedChatModel } from '../model/audited-chat-model.js';
import { executeDurableAgentLoop } from './helpers/durable-loop-execution.helper.js';
import type {
  JobExecutionStatePort,
  ReactJobExecutionResult,
} from './types/react-execution.types.js';
import type { BuiltContext } from '../context/types/context.types.js';
import {
  RuntimeEventWriter,
  type RuntimeEventPublisher,
} from '../events/runtime-event-writer.js';
import { ToolExecutor, type RuntimeTool } from './tool-executor.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { FinalAnswerPolicy } from './policies/final-answer-policy.js';
import { ToolCallPolicy } from './policies/tool-call-policy.js';
import { PendingToolCallLoader } from './recovery/pending-tool-call-loader.js';

export interface ReactExecutionOptions {
  store: AgentStore;
  jobState: JobExecutionStatePort;
  workerId: string;
  publisher: RuntimeEventPublisher;
  model: BaseChatModel;
  provider: string;
  modelName: string;
  tools: RuntimeTool[];
  sandboxRoot?: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
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
export class ReactExecution {
  readonly #toolCallPolicy: ToolCallPolicy;
  readonly #finalAnswerPolicy: FinalAnswerPolicy;
  readonly #pendingToolCallLoader: PendingToolCallLoader;

  constructor(private readonly options: ReactExecutionOptions) {
    this.#toolCallPolicy = new ToolCallPolicy(options.tools);
    this.#finalAnswerPolicy = new FinalAnswerPolicy(options.store);
    this.#pendingToolCallLoader = new PendingToolCallLoader(options.store);
  }

  async runJob(input: {
    job: AgentJob;
    loadContext(): Promise<BuiltContext>;
    signal?: AbortSignal;
  }): Promise<ReactJobExecutionResult> {
    const checkpoint = await this.options.store.getLatestLoopCheckpoint(input.job.id);
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
        model: this.#auditedModel(
          input.job,
          () => {
            if (!current) throw new Error('Model context is unavailable before tool recovery completes.');
            return current.inputManifest;
          },
          'job.react',
          'job.react',
          tools
        ),
        createOutputId,
        streaming: this.options.streaming,
      }),
      writer: this.#writer(),
      jobState: this.options.jobState,
      input: {
        job: input.job,
        loopInput: {
          context: {
            loadMessages: async () => {
              current = await input.loadContext();
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

  createAuditedModel(
    job: AgentJob,
    built: BuiltContext,
    callType: AgentModelCallType,
    logicalCallKey: string,
    tools: StructuredToolInterface[] = []
  ): AuditedChatModel {
    return this.#auditedModel(
      job,
      built.inputManifest,
      callType,
      logicalCallKey,
      tools
    );
  }

  #auditedModel(
    job: AgentJob,
    manifest: AgentContextInputManifest | (() => AgentContextInputManifest),
    callType: AgentModelCallType,
    logicalCallKey: string,
    tools: StructuredToolInterface[] = []
  ): AuditedChatModel {
    if (!job.currentAttemptId) {
      throw new Error(`Job ${JSON.stringify(job.id)} has no current attempt.`);
    }
    return new AuditedChatModel({
      delegate: this.#bindTools(tools),
      store: this.options.store,
      workerId: this.options.workerId,
      target: {
        sessionId: job.sessionId,
        jobId: job.id,
        attemptId: job.currentAttemptId,
        attemptNo: job.attemptNo,
      },
      callType,
      logicalCallKey,
      provider: this.options.provider,
      model: this.options.modelName,
      maxContextTokens: this.options.maxContextTokens,
      reservedOutputTokens: this.options.reservedOutputTokens,
      baseManifest: manifest,
      publisher: this.options.publisher,
    });
  }

  #bindTools(tools: StructuredToolInterface[]): Runnable<BaseLanguageModelInput, AIMessageChunk> {
    if (tools.length === 0) return this.options.model;
    if (!this.options.model.bindTools) {
      throw new Error(`Model ${this.options.modelName} does not support LangChain bindTools().`);
    }
    return this.options.model.bindTools(tools) as Runnable<BaseLanguageModelInput, AIMessageChunk>;
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
