import { randomUUID } from 'node:crypto';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { AgentLoop } from '../agent-loop/agent-loop.js';
import type { AgentContextInputManifest, AgentJob, AgentModelCallType } from '../domain/index.js';
import { JobCoordinator } from '../orchestration/lifecycle/job-coordinator.js';
import { AgentRunner, type JobAgentRunResult } from './agent-runner.js';
import { AuditedChatModel } from './audited-chat-model.js';
import type { BuiltContext } from './context/context-compiler.js';
import { RuntimeEventWriter, type RuntimeEventPublisher } from './runtime-event-writer.js';
import { ToolExecutor, type RuntimeTool } from './tool-executor.js';
import type { AgentStore } from '../storage/agent-store.js';
import { mapStoreError } from './runtime-errors.js';

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

/**
 * Executes one durable Job through one ReAct loop. Every model turn reloads
 * the canonical database context, so tool calls, plan updates and HITL answers
 * become visible without a nested executor or an in-memory context fork.
 */
export class ReactExecutionRuntime {
  constructor(private readonly options: ReactExecutionRuntimeOptions) {}

  async runJob(input: {
    job: AgentJob;
    loadContext(): Promise<BuiltContext>;
  }): Promise<JobAgentRunResult> {
    let current = await input.loadContext();
    const toolExecutor = this.#toolExecutor();
    const tools = toolExecutor.tools();
    const runner = new AgentRunner({
      loop: new AgentLoop({
        model: this.#auditedModel(
          input.job,
          () => current.inputManifest,
          'job.react',
          'job.react',
          tools
        ),
        streaming: true,
      }),
      writer: this.#writer(),
      coordinator: new JobCoordinator({
        store: this.options.store,
        workerId: this.options.workerId,
      }),
    });
    return runner.runJob({
      job: input.job,
      messages: current.messages,
      prepareMessages: async () => {
        current = await input.loadContext();
        return current.messages;
      },
      tools,
      exclusiveToolNames: new Set(
        this.options.tools.filter(tool => tool.exclusive).map(tool => tool.tool.name)
      ),
      validateFinalAnswer: () => this.#validateFinalAnswer(input.job.id),
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
    });
  }

  #limits() {
    return {
      maxIterations: this.options.maxIterations,
      maxToolCalls: this.options.maxToolCalls,
      deadlineMs: Date.now() + this.options.executionDeadlineMs,
    };
  }

  async #validateFinalAnswer(jobId: string) {
    try {
      const plan = await this.options.store.getPlanByJobId(jobId);
      if (!plan || plan.status === 'completed') return { type: 'accept' as const };
      const steps = await this.options.store.listPlanSteps(plan.id);
      if (plan.status === 'failed' || plan.status === 'cancelled') {
        return {
          type: 'fail' as const,
          code: 'invalid_plan_state' as const,
          message: `Plan ${JSON.stringify(plan.id)} is ${plan.status} and cannot produce a successful final answer.`,
          details: { planId: plan.id, planStatus: plan.status },
        };
      }
      const snapshot = steps.map(step => ({
        key: step.key,
        title: step.title,
        status: step.status,
        result: step.result,
      }));
      return {
        type: 'retry' as const,
        feedback: [
          'Runtime validation rejected the previous answer because the durable plan is still active.',
          'Do not answer the user yet. Call update_plan alone with the complete plan.',
          'Mark completed work completed with result summaries; mark unnecessary work skipped.',
          'Only after update_plan returns a terminal completed plan may you provide the final answer.',
          `Current plan id=${plan.id}, version=${plan.version}, steps=${JSON.stringify(snapshot)}`,
        ].join('\n'),
      };
    } catch (error) {
      throw mapStoreError(error);
    }
  }
}

function outputId(): string {
  return `output_${randomUUID()}`;
}
