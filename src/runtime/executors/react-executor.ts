import { randomUUID } from 'node:crypto';
import { HumanMessage, SystemMessage, type AIMessageChunk } from '@langchain/core/messages';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { AgentLoop } from '../../agent-loop/agent-loop.js';
import type { AgentJob, AgentModelCallType, AgentStepRun } from '../../domain/index.js';
import { STEP_OUTPUT_REPAIR_INSTRUCTION } from '../../planner/planner-prompts.js';
import { StepRunner, type StepRunnerResult } from '../../planner/step-runner.js';
import { AgentRunner, type DirectAgentRunResult } from '../agent-runner.js';
import { AuditedChatModel } from '../audited-chat-model.js';
import {
  ContextBuildService,
  type ContextMaterialSource,
} from '../context/context-build.service.js';
import { ContextCompressionService } from '../context/context-compression.service.js';
import { SessionCompressionService } from '../context/session-compression.service.js';
import type { BuiltContext } from '../context/context-compiler.js';
import type { ContextMaterial } from '../context/context-material.js';
import { JobCoordinator } from '../job-coordinator.js';
import { RuntimeEventWriter, type RuntimeEventPublisher } from '../runtime-event-writer.js';
import { ToolExecutor, type RuntimeTool } from '../tool-executor.js';
import type { AgentStore } from '../../storage/agent-store.js';

export interface ReactExecutorOptions {
  store: AgentStore;
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
}

export class ReactExecutor {
  readonly #contexts = new ContextBuildService();
  readonly #compression: ContextCompressionService;
  readonly #sessionCompression: SessionCompressionService;

  constructor(private readonly options: ReactExecutorOptions) {
    this.#compression = new ContextCompressionService({
      store: options.store,
      modelName: options.modelName,
    });
    this.#sessionCompression = new SessionCompressionService({
      store: options.store,
      modelName: options.modelName,
    });
  }

  async runDirect(input: {
    job: AgentJob;
    loadContext(): Promise<ContextMaterial>;
  }): Promise<DirectAgentRunResult> {
    const built = await this.buildContext(
      input.job,
      'job_execution',
      undefined,
      input.loadContext
    );
    const toolExecutor = this.#toolExecutor();
    const tools = toolExecutor.tools();
    const runner = new AgentRunner({
      loop: new AgentLoop({
        model: this.#auditedModel(input.job, built, 'job.react', 'job.react', undefined, tools),
        streaming: true,
      }),
      writer: this.#writer(),
      coordinator: new JobCoordinator({
        store: this.options.store,
        workerId: this.options.workerId,
      }),
    });
    return runner.runDirect({
      job: input.job,
      messages: built.messages,
      tools,
      toolExecutor,
      outputIdFactory: outputId,
      limits: this.#limits(),
    });
  }

  async runStep(input: {
    job: AgentJob;
    stepRun: AgentStepRun;
    loadContext(): Promise<ContextMaterial>;
  }): Promise<StepRunnerResult> {
    const built = await this.buildContext(
      input.job,
      'step_execution',
      input.stepRun.id,
      input.loadContext
    );
    const toolExecutor = this.#toolExecutor();
    const tools = toolExecutor.tools();
    const runner = new StepRunner({
      loop: new AgentLoop({
        model: this.#auditedModel(
          input.job,
          built,
          'step.react',
          `step.react:${input.stepRun.id}`,
          input.stepRun.id,
          tools
        ),
        streaming: true,
      }),
      writer: this.#writer(),
      store: this.options.store,
      repair: {
        repair: async ({ rawOutput, issues }) => {
          const response = await this.#auditedModel(
            input.job,
            built,
            'step.output_repair',
            `step.output_repair:${input.stepRun.id}`,
            input.stepRun.id
          ).invoke([
            new SystemMessage(STEP_OUTPUT_REPAIR_INSTRUCTION),
            new HumanMessage(JSON.stringify({ rawOutput, issues })),
          ]);
          return response.text;
        },
      },
    });
    return runner.run({
      job: input.job,
      stepRun: input.stepRun,
      messages: built.messages,
      tools,
      toolExecutor,
      outputIdFactory: outputId,
      limits: this.#limits(),
    });
  }

  createAuditedModel(
    job: AgentJob,
    built: BuiltContext,
    callType: AgentModelCallType,
    logicalCallKey: string,
    stepRunId?: string,
    tools: StructuredToolInterface[] = []
  ): AuditedChatModel {
    return this.#auditedModel(job, built, callType, logicalCallKey, stepRunId, tools);
  }

  async buildContext(
    job: AgentJob,
    purpose: 'job_execution' | 'step_execution',
    stepRunId: string | undefined,
    load: () => Promise<ContextMaterial>
  ): Promise<BuiltContext> {
    const source: ContextMaterialSource = {
      load,
      compress: async (material, built) => {
        const invoke = async (
          messages: BaseLanguageModelInput,
          compressionBuilt: BuiltContext,
          logicalCallKey: string
        ): Promise<string> => {
          const response = await this.#auditedModel(
            job,
            compressionBuilt,
            'context.compress',
            logicalCallKey,
            stepRunId
          ).invoke(messages);
          return response.text;
        };
        if (purpose === 'job_execution' && material.bundles) {
          return this.#sessionCompression.compress({ job, material, built, invoke });
        }
        return this.#compression.compress({
          job,
          ...(stepRunId ? { stepRunId } : {}),
          purpose,
          material,
          built,
          invoke,
        });
      },
    };
    return this.#contexts.build(source);
  }

  #auditedModel(
    job: AgentJob,
    built: BuiltContext,
    callType: AgentModelCallType,
    logicalCallKey: string,
    stepRunId?: string,
    tools: StructuredToolInterface[] = []
  ): AuditedChatModel {
    return new AuditedChatModel({
      delegate: this.#bindTools(tools),
      store: this.options.store,
      workerId: this.options.workerId,
      target: {
        sessionId: job.sessionId,
        jobId: job.id,
        stepRunId,
        attemptId: job.currentAttemptId!,
        attemptNo: job.attemptNo,
      },
      callType,
      logicalCallKey,
      provider: this.options.provider,
      model: this.options.modelName,
      maxContextTokens: this.options.maxContextTokens,
      reservedOutputTokens: this.options.reservedOutputTokens,
      baseManifest: built.inputManifest,
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
    });
  }

  #limits() {
    return {
      maxIterations: this.options.maxIterations,
      maxToolCalls: this.options.maxToolCalls,
      deadlineMs: Date.now() + this.options.executionDeadlineMs,
    };
  }
}

function outputId(): string {
  return `output_${randomUUID()}`;
}
