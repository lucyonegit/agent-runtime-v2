import { randomUUID } from 'node:crypto';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { AgentLoop } from '../../agent-loop/agent-loop.js';
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
import { mapStoreError } from '../errors/runtime-error.js';

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
}

/**
 * Executes one durable Job through one ReAct loop. Every model turn reloads
 * the canonical database context, so tool calls, plan updates and HITL answers
 * become visible without a nested executor or an in-memory context fork.
 */
export class ReactExecution {
  constructor(private readonly options: ReactExecutionOptions) {}

  async runJob(input: {
    job: AgentJob;
    loadContext(): Promise<BuiltContext>;
    signal?: AbortSignal;
  }): Promise<ReactJobExecutionResult> {
    const checkpoint = await this.options.store.getLatestLoopCheckpoint(input.job.id);
    const resumeToolCalls = await this.#loadPendingToolCalls(input.job, checkpoint?.callMessageId);
    let current = checkpoint?.phase === 'tool_batch'
      ? undefined
      : await input.loadContext();
    const toolExecutor = this.#toolExecutor();
    const tools = toolExecutor.tools();
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
        streaming: true,
      }),
      writer: this.#writer(),
      jobState: this.options.jobState,
      input: {
        job: input.job,
        messages: current?.messages ?? [],
        prepareMessages: async () => {
          current = await input.loadContext();
          return current.messages;
        },
        tools,
        exclusiveToolNames: new Set(
          this.options.tools.filter(tool => tool.exclusive).map(tool => tool.tool.name)
        ),
        validateToolCalls: candidate => this.#validateToolCalls(candidate.toolCalls),
        validateFinalAnswer: () => this.#validateFinalAnswer(input.job.id),
        toolExecutor,
        outputIdFactory: outputId,
        limits: this.#limits(input.job, input.signal),
        initialIterationNo: checkpoint?.iterationNo ?? 0,
        initialExecutedToolCalls: checkpoint?.executedToolCalls ?? 0,
        resumeToolCalls,
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

  async #loadPendingToolCalls(job: AgentJob, callMessageId?: string) {
    if (!callMessageId) return [];
    const [messages, invocations] = await Promise.all([
      this.options.store.listSessionMessages(job.sessionId),
      this.options.store.listSessionToolInvocations(job.sessionId),
    ]);
    const callMessage = messages.find(message => message.id === callMessageId);
    if (!callMessage?.toolCalls?.length) {
      throw new Error(`Checkpoint tool batch ${JSON.stringify(callMessageId)} has no call message.`);
    }
    const byCallId = new Map(
      invocations
        .filter(invocation => invocation.jobId === job.id && invocation.callMessageId === callMessageId)
        .map(invocation => [invocation.toolCallId, invocation])
    );
    return callMessage.toolCalls.flatMap(call => {
      const invocation = byCallId.get(call.id);
      if (!invocation) {
        throw new Error(`Checkpoint tool call ${JSON.stringify(call.id)} has no invocation.`);
      }
      if (['completed', 'failed'].includes(invocation.status)) return [];
      if (invocation.status !== 'pending') {
        throw new Error(
          `Checkpoint tool call ${JSON.stringify(call.id)} cannot resume from ${invocation.status}.`
        );
      }
      return [{ ...call, args: invocation.arguments }];
    });
  }

  async #validateToolCalls(toolCalls: Array<{ name: string }>) {
    const contractByName = new Map(this.options.tools.map(tool => [tool.tool.name, tool]));
    const freshContextCall = toolCalls.find(call => contractByName.get(call.name)?.requiresFreshContext);
    const prerequisiteSibling = freshContextCall
      ? toolCalls.find(call => !contractByName.get(call.name)?.requiresFreshContext)
      : undefined;
    if (!freshContextCall || !prerequisiteSibling) return { type: 'accept' as const };
    return {
      type: 'retry' as const,
      code: 'tool_batch.requires_fresh_context',
      feedback: [
        `Runtime validation rejected the previous tool batch because ${JSON.stringify(freshContextCall.name)} cannot share a model turn with prerequisite tool ${JSON.stringify(prerequisiteSibling.name)}.`,
        `The rejected batch was not persisted or executed: ${JSON.stringify(toolCalls.map(call => call.name))}.`,
        'Execute searches and reads first, wait for their ToolMessages, then call the write tool alone using those observed results.',
      ].join('\n'),
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
        code: 'final.plan_incomplete',
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
