import { createHash, randomUUID } from 'node:crypto';
import { HumanMessage, SystemMessage, type AIMessageChunk } from '@langchain/core/messages';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { AgentLoop } from '../../agent-loop/agent-loop.js';
import { ContextBuilder } from '../../context/context-builder.js';
import type { BuiltContext } from '../../context/context-builder.js';
import { CONTEXT_RULES_VERSION } from '../../context/context-purpose.js';
import type { AgentJob, AgentModelCallType } from '../../domain/index.js';
import type { JobExecutionService } from '../../orchestration/agent-runtime.js';
import { PlanEngine } from '../../planner/plan-engine.js';
import { PlanSummarizer } from '../../planner/plan-summarizer.js';
import {
  STEP_OUTPUT_INSTRUCTION,
  STEP_OUTPUT_REPAIR_INSTRUCTION,
} from '../../planner/planner-prompts.js';
import { StepRunner } from '../../planner/step-runner.js';
import { AgentRunner } from '../../runtime/agent-runner.js';
import { AuditedChatModel } from '../../runtime/audited-chat-model.js';
import { JobCoordinator } from '../../runtime/job-coordinator.js';
import { RuntimeError } from '../../runtime/runtime-errors.js';
import { RuntimeEventWriter, type RuntimeEventPublisher } from '../../runtime/runtime-event-writer.js';
import { ToolExecutor, type RuntimeTool } from '../../runtime/tool-executor.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { DefaultPlanner, DefaultPlanSummarizer } from './default-planner.js';

export interface RuntimeJobExecutionOptions {
  store: AgentStore;
  workerId: string;
  publisher: RuntimeEventPublisher;
  model: BaseChatModel;
  provider: string;
  modelName: string;
  tools: RuntimeTool[];
  sandboxRoot?: string;
  maxContextTokens?: number;
  reservedOutputTokens?: number;
  maxIterations?: number;
  maxToolCalls?: number;
  executionDeadlineMs?: number;
  jobLeaseMs?: number;
  jobHeartbeatMs?: number;
  compressionMessageThreshold?: number;
}

export class RuntimeJobExecutionService implements JobExecutionService {
  readonly #running = new Set<string>();
  readonly #context = new ContextBuilder();
  readonly #options: Required<Omit<RuntimeJobExecutionOptions,
    'store' | 'publisher' | 'model' | 'tools' | 'workerId' | 'provider' | 'modelName' | 'sandboxRoot'>>
    & RuntimeJobExecutionOptions;

  constructor(options: RuntimeJobExecutionOptions) {
    this.#options = {
      maxContextTokens: 128_000,
      reservedOutputTokens: 4_096,
      maxIterations: 24,
      maxToolCalls: 48,
      executionDeadlineMs: 15 * 60_000,
      jobLeaseMs: 20 * 60_000,
      jobHeartbeatMs: 60_000,
      compressionMessageThreshold: 50,
      ...options,
    };
    if (this.#options.jobHeartbeatMs >= this.#options.jobLeaseMs) {
      throw new RangeError('jobHeartbeatMs must be shorter than jobLeaseMs.');
    }
  }

  async execute(jobId: string): Promise<void> {
    if (this.#running.has(jobId)) return;
    this.#running.add(jobId);
    const stopHeartbeat = this.#startHeartbeat(jobId);
    try {
      await this.#executeOwnedJob(jobId);
    } catch (error) {
      if (!(error instanceof RuntimeError && error.code === 'lease_lost')) {
        await this.#failIfOwned(jobId, error);
      }
    } finally {
      stopHeartbeat();
      this.#running.delete(jobId);
    }
  }

  async #executeOwnedJob(jobId: string): Promise<void> {
    let job = await this.#requireOwnedJob(jobId);
    const messages = await this.#options.store.listSessionMessages(job.sessionId);
    const originalGoal = messages.find(message => (
      message.jobId === job.id && message.messageType === 'user_message'
    ))?.content;
    if (!originalGoal) throw new Error(`Job ${job.id} has no original user goal.`);
    const jobContext = await this.#buildContext(job, originalGoal, 'job_execution');
    const planner = this.#createPlanEngine(job, jobContext);

    if (!job.strategy || job.stage === 'planning' && !await this.#options.store.getPlanByJobId(job.id)) {
      const routed = await planner.route(job, originalGoal, {
        ...currentTemporalContext(),
        availableTools: this.#options.tools.map(item => item.tool.name),
      });
      job = routed.job;
      if (routed.strategy === 'planned' && 'plan' in routed) job = routed.job;
    }
    if (job.strategy === 'direct') {
      await this.#runDirect(job, originalGoal);
      return;
    }
    await this.#runPlanned(job, originalGoal, planner);
  }

  async #runDirect(job: AgentJob, originalGoal: string): Promise<void> {
    const built = await this.#buildContext(job, originalGoal, 'job_execution');
    const tools = this.#options.tools;
    const toolExecutor = new ToolExecutor({
      store: this.#options.store,
      workerId: this.#options.workerId,
      tools,
      sandboxRoot: this.#options.sandboxRoot,
    });
    const langChainTools = toolExecutor.tools();
    const audited = this.#auditedModel(
      job, built, 'job.react', 'job.react', undefined, langChainTools
    );
    const writer = this.#writer(tools);
    const coordinator = new JobCoordinator({
      store: this.#options.store,
      workerId: this.#options.workerId,
    });
    const runner = new AgentRunner({
      loop: new AgentLoop({ model: audited, streaming: true }),
      writer,
      coordinator,
    });
    const result = await runner.runDirect({
      job,
      messages: built.messages,
      tools: langChainTools,
      toolExecutor,
      outputIdFactory: outputId,
      limits: this.#limits(),
    });
    if (result.type === 'failed' || result.type === 'cancelled') {
      await this.#safePublish({ type: 'job.upserted', sessionId: result.job.sessionId, job: result.job });
    }
  }

  async #runPlanned(job: AgentJob, originalGoal: string, engine: PlanEngine): Promise<void> {
    while (true) {
      const current = await this.#requireOwnedJob(job.id);
      if (current.status === 'waiting_user_input' || isTerminal(current)) return;
      if (current.stage === 'finalizing') {
        const temporalContext = currentTemporalContext();
        await engine.finalize(
          current,
          originalGoal,
          temporalContext.currentDate,
          temporalContext.timezone
        );
        return;
      }
      const runs = await this.#options.store.listJobStepRuns(current.id);
      let activeRun = runs.find(run => ['running', 'resuming'].includes(run.status));
      let currentJob = current;
      if (!activeRun) {
        const created = await engine.createNextStepRun(current);
        if (!created) throw new Error('Planned Job has no pending step and is not finalizing.');
        activeRun = created.stepRun;
        currentJob = created.job;
      }
      const plan = await this.#options.store.getPlanByJobId(current.id);
      const steps = plan ? await this.#options.store.listPlanSteps(plan.id) : [];
      const step = steps.find(candidate => candidate.id === activeRun!.stepId);
      if (!step) throw new Error(`StepRun ${activeRun.id} has no PlanStep.`);
      const built = await this.#buildContext(
        currentJob,
        originalGoal,
        'step_execution',
        activeRun,
        step.instruction
      );
      const langChainTools = this.#options.tools.map(tool => tool.tool);
      const audited = this.#auditedModel(
        currentJob,
        built,
        'step.react',
        `step.react:${activeRun.id}`,
        activeRun.id,
        langChainTools
      );
      const toolExecutor = new ToolExecutor({
        store: this.#options.store,
        workerId: this.#options.workerId,
        tools: this.#options.tools,
        sandboxRoot: this.#options.sandboxRoot,
      });
      const runner = new StepRunner({
        loop: new AgentLoop({ model: audited, streaming: true }),
        writer: this.#writer(this.#options.tools),
        store: this.#options.store,
        repair: {
          repair: async ({ rawOutput, issues }) => {
            const repairModel = this.#auditedModel(
              currentJob,
              built,
              'step.output_repair',
              `step.output_repair:${activeRun!.id}`,
              activeRun!.id
            );
            const response = await repairModel.invoke([
              new SystemMessage(STEP_OUTPUT_REPAIR_INSTRUCTION),
              new HumanMessage(JSON.stringify({ rawOutput, issues })),
            ]);
            return response.text;
          },
        },
      });
      const result = await runner.run({
        job: currentJob,
        stepRun: activeRun,
        messages: built.messages,
        tools: langChainTools,
        toolExecutor,
        outputIdFactory: outputId,
        limits: this.#limits(),
      });
      if (result.type === 'waiting_user_input') return;
      if (result.type === 'failed' && !result.retryStep) return;
      job = result.job;
    }
  }

  #createPlanEngine(job: AgentJob, built: BuiltContext): PlanEngine {
    const route = this.#auditedModel(job, built, 'planner.route', 'planner.route');
    const create = this.#auditedModel(job, built, 'planner.create', 'planner.create');
    const finalize = this.#auditedModel(job, built, 'plan.finalize', 'plan.finalize');
    return new PlanEngine({
      store: this.#options.store,
      workerId: this.#options.workerId,
      planner: new DefaultPlanner(route, create),
      summarizer: new PlanSummarizer(new DefaultPlanSummarizer(finalize)),
      publisher: this.#options.publisher,
    });
  }

  #startHeartbeat(jobId: string): () => void {
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.#renewLease(jobId).finally(() => { renewing = false; });
    }, this.#options.jobHeartbeatMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #renewLease(jobId: string): Promise<void> {
    const job = await this.#options.store.getJob(jobId);
    if (!job || !['running', 'resuming'].includes(job.status)
      || job.leaseOwner !== this.#options.workerId || !job.currentAttemptId) return;
    try {
      const coordinator = new JobCoordinator({
        store: this.#options.store,
        workerId: this.#options.workerId,
        limits: {
          jobLeaseMs: this.#options.jobLeaseMs,
          jobHeartbeatMs: this.#options.jobHeartbeatMs,
        },
      });
      const renewed = await coordinator.renewJobLease(job);
      await this.#safePublish({ type: 'job.upserted', sessionId: renewed.sessionId, job: renewed });
    } catch {
      // The next fenced write observes a lost lease and stops this execution.
    }
  }

  async #buildContext(
    job: AgentJob,
    originalGoal: string,
    purpose: 'job_execution' | 'step_execution',
    stepRun?: Parameters<ContextBuilder['build']>[0]['stepRun'],
    currentInstruction?: string
  ): Promise<BuiltContext> {
    const [messages, invocations, summaries] = await Promise.all([
      this.#options.store.listSessionMessages(job.sessionId),
      this.#options.store.listSessionToolInvocations(job.sessionId),
      this.#options.store.listActiveContextSummaries(
        stepRun ? 'step_run' : 'job',
        stepRun?.id ?? job.id,
        purpose,
        CONTEXT_RULES_VERSION
      ),
    ]);
    const buildInput = {
      job,
      stepRun,
      attemptId: job.currentAttemptId!,
      purpose,
      systemPrompt: purpose === 'step_execution'
        ? `Execute only the current PlanStep. ${STEP_OUTPUT_INSTRUCTION}`
        : 'Act as a reliable tool-using agent. Complete the user goal.',
      systemPromptVersion: 'runtime-system-v1',
      originalGoal,
      currentInstruction,
      messages,
      invocations,
      summaries: summaries.map(summary => ({
        id: summary.id,
        summary: summary.summary,
        sourceRowIdEnd: summary.sourceRowIdEnd,
      })),
      model: {
        provider: this.#options.provider,
        name: this.#options.modelName,
        maxContextTokens: this.#options.maxContextTokens,
        reservedOutputTokens: this.#options.reservedOutputTokens,
      },
      toolSchemas: this.#options.tools.map(tool => tool.tool),
      newCompressibleMessageCount: messages.filter(message => (
        message.rowId > Math.max(0, ...summaries.map(summary => summary.sourceRowIdEnd))
        && !isCurrentJobGoalMessage(message, job.id, originalGoal)
      )).length,
      compressionMessageThreshold: this.#options.compressionMessageThreshold,
    } satisfies Parameters<ContextBuilder['build']>[0];
    const built = this.#context.build(buildInput);
    if (!built.compressionRecommended) return built;
    return this.#compressContext(job, originalGoal, purpose, buildInput, built, stepRun?.id);
  }

  async #compressContext(
    job: AgentJob,
    originalGoal: string,
    purpose: 'job_execution' | 'step_execution',
    buildInput: Parameters<ContextBuilder['build']>[0],
    built: BuiltContext,
    stepRunId?: string
  ): Promise<BuiltContext> {
    const compressibleIds = new Set(built.compressibleMessageIds);
    const sourceMessages = buildInput.messages.filter(message => compressibleIds.has(message.id));
    if (sourceMessages.length === 0) return built;
    const start = Math.min(...sourceMessages.map(message => message.rowId));
    const end = Math.max(...sourceMessages.map(message => message.rowId));
    const compressionContext = this.#context.build({
      ...buildInput,
      messages: sourceMessages,
      purpose: 'context_compression',
      compressionSourcePurpose: purpose,
      systemPrompt: 'Compress the supplied runtime history into a concise factual summary. Preserve decisions, constraints, tool outcomes, unresolved issues, and identifiers. Do not add facts.',
      systemPromptVersion: 'context-compress-v1',
      newCompressibleMessageCount: 0,
      compressionMessageThreshold: Number.MAX_SAFE_INTEGER,
    });
    const model = this.#auditedModel(
      job,
      compressionContext,
      'context.compress',
      `context.compress:${stepRunId ?? job.id}:${end}`,
      stepRunId
    );
    const response = await model.invoke(compressionContext.messages);
    const summary = response.text.trim();
    if (!summary) throw new Error('Context compression returned an empty summary.');
    await this.#options.store.replaceContextSummary({
      id: `summary_${randomUUID()}`,
      sessionId: job.sessionId,
      jobId: job.id,
      ...(stepRunId ? { stepRunId } : {}),
      ownerType: stepRunId ? 'step_run' : 'job',
      ownerId: stepRunId ?? job.id,
      purpose,
      contextRulesVersion: built.contextRulesVersion,
      summaryType: stepRunId ? 'working_set' : 'job',
      sourceRowIdStart: start,
      sourceRowIdEnd: end,
      parentSummaryId: buildInput.summaries?.at(-1)?.id,
      summary,
      summaryFormat: 'markdown',
      sourceMessageCount: sourceMessages.length,
      sourceTokenCount: compressionContext.estimatedInputTokens,
      summaryTokenCount: Math.max(1, Math.ceil(summary.length / 4)),
      model: this.#options.modelName,
      compressionPromptVersion: 'context-compress-v1',
      checksum: createHash('sha256').update(summary).digest('hex'),
      metadata: { inputManifest: compressionContext.inputManifest },
      nowMs: Date.now(),
    });
    const summaries = await this.#options.store.listActiveContextSummaries(
      stepRunId ? 'step_run' : 'job',
      stepRunId ?? job.id,
      purpose,
      built.contextRulesVersion
    );
    return this.#context.build({
      ...buildInput,
      summaries: summaries.map(item => ({
        id: item.id,
        summary: item.summary,
        sourceRowIdEnd: item.sourceRowIdEnd,
      })),
      newCompressibleMessageCount: 0,
    });
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
      store: this.#options.store,
      workerId: this.#options.workerId,
      target: {
        sessionId: job.sessionId,
        jobId: job.id,
        stepRunId,
        attemptId: job.currentAttemptId!,
      },
      callType,
      logicalCallKey,
      provider: this.#options.provider,
      model: this.#options.modelName,
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
      baseManifest: built.inputManifest,
      publisher: this.#options.publisher,
    });
  }

  #bindTools(tools: StructuredToolInterface[]): Runnable<BaseLanguageModelInput, AIMessageChunk> {
    if (tools.length === 0) return this.#options.model;
    if (!this.#options.model.bindTools) {
      throw new Error(`Model ${this.#options.modelName} does not support LangChain bindTools().`);
    }
    return this.#options.model.bindTools(tools) as Runnable<BaseLanguageModelInput, AIMessageChunk>;
  }

  #writer(tools: RuntimeTool[]): RuntimeEventWriter {
    return new RuntimeEventWriter({
      store: this.#options.store,
      workerId: this.#options.workerId,
      tools,
      publisher: this.#options.publisher,
    });
  }

  #limits() {
    return {
      maxIterations: this.#options.maxIterations,
      maxToolCalls: this.#options.maxToolCalls,
      deadlineMs: Date.now() + this.#options.executionDeadlineMs,
    };
  }

  async #requireOwnedJob(jobId: string): Promise<AgentJob> {
    const job = await this.#options.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} was not found.`);
    if (!['running', 'resuming'].includes(job.status)
      || job.leaseOwner !== this.#options.workerId
      || !job.currentAttemptId
      || !job.leaseExpiresAtMs
      || job.leaseExpiresAtMs <= Date.now()) {
      throw new RuntimeError('lease_lost', `Job ${jobId} is not owned by this worker.`);
    }
    return job;
  }

  async #failIfOwned(jobId: string, error: unknown): Promise<void> {
    const job = await this.#options.store.getJob(jobId);
    if (!job || !job.currentAttemptId || job.leaseOwner !== this.#options.workerId
      || !['running', 'resuming'].includes(job.status)) return;
    const coordinator = new JobCoordinator({
      store: this.#options.store,
      workerId: this.#options.workerId,
    });
    try {
      const failed = await coordinator.failJob(job, {
        code: error instanceof RuntimeError ? error.code : 'runtime_error',
        message: error instanceof Error ? error.message : 'Runtime execution failed.',
      });
      await this.#safePublish({ type: 'job.upserted', sessionId: failed.sessionId, job: failed });
    } catch {
      // A newer owner or terminal transaction won the race.
    }
  }

  async #safePublish(event: Parameters<RuntimeEventPublisher['publish']>[0]): Promise<void> {
    try {
      await this.#options.publisher.publish(event);
    } catch {
      // The durable SessionView remains authoritative when realtime delivery fails.
    }
  }
}

function isTerminal(job: AgentJob): boolean {
  return ['completed', 'failed', 'cancelled'].includes(job.status);
}

function currentTemporalContext(): { currentDate: string; timezone: string } {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { currentDate: `${values.year}-${values.month}-${values.day}`, timezone };
}

function isCurrentJobGoalMessage(
  message: { jobId: string; messageType: string; content: string },
  jobId: string,
  originalGoal: string
): boolean {
  return message.jobId === jobId
    && message.messageType === 'user_message'
    && message.content === originalGoal;
}

function outputId(): string {
  return `output_${randomUUID()}`;
}
