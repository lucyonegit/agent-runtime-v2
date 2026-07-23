import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentJob } from '../../domain/index.js';
import type { JobExecutionService } from '../agent-runtime.js';
import { ReactExecutionRuntime } from '../../runtime/execution/react-execution-runtime.js';
import { ContextCompressionService } from '../../runtime/context/context-compression.service.js';
import { ReActContextService } from '../../runtime/context/react-context.service.js';
import { JobCoordinator } from '../lifecycle/job-coordinator.js';
import { resolveJobGoalMessage } from '../../runtime/job-goal.js';
import { RuntimeError } from '../../runtime/runtime-errors.js';
import type { RuntimeEventPublisher } from '../../runtime/runtime-event-writer.js';
import type { RuntimeTool } from '../../runtime/execution/tool-executor.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { buildStableEnvironmentContext } from '../../runtime/prompting/job-agent-prompt.js';

export interface JobExecutionOrchestratorOptions {
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
  inputTokenLimit?: number;
  maxIterations?: number;
  maxToolCalls?: number;
  executionDeadlineMs?: number;
  jobLeaseMs?: number;
  jobHeartbeatMs?: number;
  jobSystemPrompt: string;
  systemPromptVersion: string;
  promptId: string;
  promptVersion: number;
}

/**
 * Orchestration owns Job lifecycle, leases and composition. Runtime owns the
 * replaceable ReAct mechanics. Planning is intentionally absent here because
 * it is a durable tool used from inside that one loop.
 */
export class JobExecutionOrchestrator implements JobExecutionService {
  readonly #activeExecutions = new Map<string, {
    controller: AbortController;
    completion: Promise<void>;
  }>();
  readonly #options: Required<Omit<JobExecutionOrchestratorOptions,
    'store' | 'publisher' | 'model' | 'tools' | 'workerId' | 'provider' | 'modelName' | 'sandboxRoot'>>
    & JobExecutionOrchestratorOptions;
  readonly #react: ReactExecutionRuntime;
  readonly #contexts: ReActContextService;

  constructor(options: JobExecutionOrchestratorOptions) {
    const maxContextTokens = options.maxContextTokens ?? 128_000;
    const reservedOutputTokens = options.reservedOutputTokens ?? 4_096;
    const inputTokenLimit = options.inputTokenLimit
      ?? maxContextTokens - reservedOutputTokens;
    this.#options = {
      maxContextTokens,
      reservedOutputTokens,
      inputTokenLimit,
      maxIterations: 24,
      maxToolCalls: 48,
      executionDeadlineMs: 15 * 60_000,
      jobLeaseMs: 30_000,
      jobHeartbeatMs: 10_000,
      ...options,
    };
    if (this.#options.jobHeartbeatMs >= this.#options.jobLeaseMs) {
      throw new RangeError('jobHeartbeatMs must be shorter than jobLeaseMs.');
    }
    const modelBudget = {
      provider: this.#options.provider,
      name: this.#options.modelName,
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
      inputTokenLimit: this.#options.inputTokenLimit,
    };
    this.#react = new ReactExecutionRuntime({
      store: this.#options.store,
      workerId: this.#options.workerId,
      publisher: this.#options.publisher,
      model: this.#options.model,
      provider: this.#options.provider,
      modelName: this.#options.modelName,
      tools: this.#options.tools,
      sandboxRoot: this.#options.sandboxRoot,
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
      maxIterations: this.#options.maxIterations,
      maxToolCalls: this.#options.maxToolCalls,
      executionDeadlineMs: this.#options.executionDeadlineMs,
    });
    this.#contexts = new ReActContextService({
      store: this.#options.store,
      systemPrompt: this.#options.jobSystemPrompt,
      systemPromptVersion: this.#options.systemPromptVersion,
      promptId: this.#options.promptId,
      promptVersion: this.#options.promptVersion,
      model: modelBudget,
      toolSchemas: this.#options.tools.map(tool => tool.tool),
      stableContext: sessionId => buildStableEnvironmentContext({
        sandboxRoot: this.#options.sandboxRoot ?? '.agent-sandbox',
        sessionId,
      }),
      compression: new ContextCompressionService({
        store: this.#options.store,
        modelName: this.#options.modelName,
      }),
      compressionModels: {
        create: ({ job, context, logicalCallKey }) => this.#react.createAuditedModel(
          job,
          context,
          'context.compress',
          logicalCallKey
        ),
      },
    });
  }

  async executeJob(jobId: string): Promise<void> {
    const existingExecution = this.#activeExecutions.get(jobId);
    if (existingExecution) return existingExecution.completion;
    const execution = {
      controller: new AbortController(),
      completion: Promise.resolve(),
    };
    this.#activeExecutions.set(jobId, execution);
    execution.completion = this.#runJobWithLease(jobId, execution.controller.signal).finally(() => {
      if (this.#activeExecutions.get(jobId) === execution) {
        this.#activeExecutions.delete(jobId);
      }
    });
    return execution.completion;
  }

  cancelJobExecution(jobId: string): void {
    this.#activeExecutions.get(jobId)?.controller.abort();
  }

  async shutdown(): Promise<void> {
    const activeExecutions = [...this.#activeExecutions.values()];
    for (const execution of activeExecutions) execution.controller.abort('runtime_shutdown');
    await Promise.allSettled(activeExecutions.map(execution => execution.completion));
  }

  async #runJobWithLease(jobId: string, signal: AbortSignal): Promise<void> {
    const stopLeaseHeartbeat = this.#startLeaseHeartbeat(jobId);
    try {
      await this.#executeJob(jobId, signal);
    } catch (error) {
      if (!(error instanceof RuntimeError && ['lease_lost', 'aborted'].includes(error.code))) {
        await this.#failJobIfStillOwned(jobId, error);
      }
    } finally {
      stopLeaseHeartbeat();
    }
  }

  async #executeJob(jobId: string, signal: AbortSignal): Promise<void> {
    const job = await this.#loadRunnableOwnedJob(jobId);
    const messages = await this.#options.store.listSessionMessages(job.sessionId);
    const originalGoal = resolveJobGoalMessage(job, messages)?.content;
    if (!originalGoal) throw new Error(`Job ${job.id} has no original user goal.`);
    await this.#react.runJob({
      job,
      loadContext: () => this.#contexts.buildForJob(job, originalGoal),
      signal,
    });
  }

  #startLeaseHeartbeat(jobId: string): () => void {
    let leaseRenewalInProgress = false;
    const timer = setInterval(() => {
      if (leaseRenewalInProgress) return;
      leaseRenewalInProgress = true;
      void this.#renewExecutionLease(jobId).finally(() => { leaseRenewalInProgress = false; });
    }, this.#options.jobHeartbeatMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async #renewExecutionLease(jobId: string): Promise<void> {
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
      // Heartbeats only keep the current execution ownership alive. They are
      // operational bookkeeping, not a user-visible Job state transition.
      await coordinator.renewJobExecutionLease(job);
    } catch {
      // The next fenced write observes the lost lease.
    }
  }

  async #loadRunnableOwnedJob(jobId: string): Promise<AgentJob> {
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

  async #failJobIfStillOwned(jobId: string, error: unknown): Promise<void> {
    const job = await this.#options.store.getJob(jobId);
    if (!job || !job.currentAttemptId || job.leaseOwner !== this.#options.workerId
      || !['running', 'resuming'].includes(job.status)) return;
    const coordinator = new JobCoordinator({
      store: this.#options.store,
      workerId: this.#options.workerId,
    });
    try {
      const failedJob = await coordinator.failJob(job, {
        code: error instanceof RuntimeError ? error.code : 'runtime_error',
        message: error instanceof Error ? error.message : 'Runtime execution failed.',
      });
      await this.#publishWithoutFailingExecution({
        type: 'job.upserted',
        sessionId: failedJob.sessionId,
        job: failedJob,
      });
    } catch {
      // A newer owner or terminal transaction won the race.
    }
  }

  async #publishWithoutFailingExecution(
    event: Parameters<RuntimeEventPublisher['publish']>[0]
  ): Promise<void> {
    try {
      await this.#options.publisher.publish(event);
    } catch {
      // SessionView is authoritative when realtime delivery fails.
    }
  }
}
