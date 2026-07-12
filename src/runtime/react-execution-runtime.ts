import { randomUUID } from 'node:crypto';
import { HumanMessage, SystemMessage, type AIMessageChunk } from '@langchain/core/messages';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { AgentLoop } from '../agent-loop/agent-loop.js';
import type { AgentJob, AgentModelCallType, AgentStepRun } from '../domain/index.js';
import { STEP_OUTPUT_REPAIR_INSTRUCTION } from '../planner/planner-prompts.js';
import { StepRunner, type StepRunnerResult } from '../planner/step-runner.js';
import { AgentRunner, type DirectAgentRunResult } from './agent-runner.js';
import { AuditedChatModel } from './audited-chat-model.js';
import type { BuiltContext } from './context/context-compiler.js';
import { JobCoordinator } from '../orchestration/lifecycle/job-coordinator.js';
import { RuntimeEventWriter, type RuntimeEventPublisher } from './runtime-event-writer.js';
import { ToolExecutor, type RuntimeTool } from './tool-executor.js';
import type { AgentStore } from '../storage/agent-store.js';

export interface ReactExecutionRuntimeOptions {
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

export class ReactExecutionRuntime {
  constructor(private readonly options: ReactExecutionRuntimeOptions) {}

  async runDirect(input: {
    job: AgentJob;
    context: BuiltContext;
  }): Promise<DirectAgentRunResult> {
    const built = input.context;
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
    context: BuiltContext;
  }): Promise<StepRunnerResult> {
    const built = input.context;
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

