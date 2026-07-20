import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentJob } from '../../domain/index.js';
import type { JobExecutionService } from '../agent-runtime.js';
import { ReactExecutionRuntime } from '../../runtime/react-execution-runtime.js';
import { JobContextLoader } from '../../runtime/loaders/job-context-loader.js';
import { JobCoordinator } from '../lifecycle/job-coordinator.js';
import { resolveJobGoalMessage } from '../../runtime/job-goal.js';
import { RuntimeError } from '../../runtime/runtime-errors.js';
import type { RuntimeEventPublisher } from '../../runtime/runtime-event-writer.js';
import type { RuntimeTool } from '../../runtime/tool-executor.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { ExecutionContextProvider } from './execution-context-provider.js';

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
  maxIterations?: number;
  maxToolCalls?: number;
  executionDeadlineMs?: number;
  jobLeaseMs?: number;
  jobHeartbeatMs?: number;
  compressionMessageThreshold?: number;
  jobSystemPrompt: string;
  systemPromptVersion: string;
}

/**
 * Orchestration owns Job lifecycle, leases and composition. Runtime owns the
 * replaceable ReAct mechanics. Planning is intentionally absent here because
 * it is a durable tool used from inside that one loop.
 */
export class JobExecutionOrchestrator implements JobExecutionService {
  readonly #running = new Set<string>();
  readonly #options: Required<Omit<JobExecutionOrchestratorOptions,
    'store' | 'publisher' | 'model' | 'tools' | 'workerId' | 'provider' | 'modelName' | 'sandboxRoot'>>
    & JobExecutionOrchestratorOptions;
  readonly #react: ReactExecutionRuntime;
  readonly #contexts: ExecutionContextProvider;

  constructor(options: JobExecutionOrchestratorOptions) {
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
    const modelBudget = {
      provider: this.#options.provider,
      name: this.#options.modelName,
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
    };
    const jobContext = new JobContextLoader({
      store: this.#options.store,
      systemPrompt: this.#options.jobSystemPrompt,
      systemPromptVersion: this.#options.systemPromptVersion,
      model: modelBudget,
      toolSchemas: this.#options.tools.map(tool => tool.tool),
      compressionMessageThreshold: this.#options.compressionMessageThreshold,
    });
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
    this.#contexts = new ExecutionContextProvider({
      store: this.#options.store,
      modelName: this.#options.modelName,
      jobContext,
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
    const job = await this.#requireOwnedJob(jobId);
    const messages = await this.#options.store.listSessionMessages(job.sessionId);
    const originalGoal = resolveJobGoalMessage(job, messages)?.content;
    if (!originalGoal) throw new Error(`Job ${job.id} has no original user goal.`);
    await this.#react.runJob({
      job,
      loadContext: () => this.#contexts.buildJobContext(job, originalGoal),
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
      // The next fenced write observes the lost lease.
    }
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
      // SessionView is authoritative when realtime delivery fails.
    }
  }
}
