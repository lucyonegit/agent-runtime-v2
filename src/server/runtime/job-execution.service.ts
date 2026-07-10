import { createHash, randomUUID } from 'node:crypto';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { AgentLoop } from '../../agent-loop/agent-loop.js';
import type { AgentLoopModelPort } from '../../agent-loop/model-port.js';
import { ContextBuilder } from '../../context/context-builder.js';
import type { BuiltContext } from '../../context/context-builder.js';
import type { AgentJob, AgentModelCallType } from '../../domain/index.js';
import type { JobExecutionService } from '../../orchestration/agent-runtime.js';
import { PlanEngine } from '../../planner/plan-engine.js';
import { PlanSummarizer } from '../../planner/plan-summarizer.js';
import { StepRunner } from '../../planner/step-runner.js';
import { AgentRunner } from '../../runtime/agent-runner.js';
import { AuditedModelPort } from '../../runtime/audited-model-port.js';
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
  model: AgentLoopModelPort;
  provider: string;
  modelName: string;
  tools: RuntimeTool[];
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
    'store' | 'publisher' | 'model' | 'tools' | 'workerId' | 'provider' | 'modelName'>>
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
      const routed = await planner.route(job, originalGoal);
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
    const audited = this.#auditedModel(job, built, 'job.react', 'job.react');
    const tools = this.#options.tools;
    const toolExecutor = new ToolExecutor({
      store: this.#options.store,
      workerId: this.#options.workerId,
      tools,
    });
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
      tools: toolExecutor.definitions(),
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
        await engine.finalize(
          current,
          originalGoal,
          new Date().toISOString().slice(0, 10),
          Intl.DateTimeFormat().resolvedOptions().timeZone
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
      const audited = this.#auditedModel(
        currentJob,
        built,
        'step.react',
        `step.react:${activeRun.id}`,
        activeRun.id
      );
      const toolExecutor = new ToolExecutor({
        store: this.#options.store,
        workerId: this.#options.workerId,
        tools: this.#options.tools,
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
            const response = await repairModel.invoke({
              messages: [
                new SystemMessage('Repair the value into valid StepOutputV1 JSON only.'),
                new HumanMessage(JSON.stringify({ rawOutput, issues })),
              ],
              tools: [],
            });
            return response.content;
          },
        },
      });
      const result = await runner.run({
        job: currentJob,
        stepRun: activeRun,
        messages: built.messages,
        tools: toolExecutor.definitions(),
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
        'job-step-run-context-v1'
      ),
    ]);
    const buildInput = {
      job,
      stepRun,
      attemptId: job.currentAttemptId!,
      purpose,
      systemPrompt: purpose === 'step_execution'
        ? 'Execute only the current PlanStep. Return StepOutputV1 JSON when complete.'
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
      toolSchemas: this.#options.tools.map(tool => tool.definition),
      newCompressibleMessageCount: messages.filter(message => (
        message.rowId > Math.max(0, ...summaries.map(summary => summary.sourceRowIdEnd))
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
    const start = built.inputManifest.includedRowIdStart;
    const end = built.inputManifest.includedRowIdEnd;
    if (start === undefined || end === undefined) return built;
    const sourceMessages = buildInput.messages.filter(message => message.rowId >= start && message.rowId <= end);
    if (sourceMessages.length === 0) return built;
    const compressionContext = this.#context.build({
      ...buildInput,
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
    const response = await model.invoke({ messages: compressionContext.messages, tools: [] });
    const summary = typeof response.content === 'string' ? response.content.trim() : JSON.stringify(response.content);
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
    stepRunId?: string
  ): AuditedModelPort {
    return new AuditedModelPort({
      delegate: this.#options.model,
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

  #writer(tools: RuntimeTool[]): RuntimeEventWriter {
    return new RuntimeEventWriter({
      store: this.#options.store,
      workerId: this.#options.workerId,
      tools: tools.map(tool => tool.definition),
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

function outputId(): string {
  return `output_${randomUUID()}`;
}
