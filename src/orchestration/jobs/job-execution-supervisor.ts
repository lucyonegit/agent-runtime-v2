import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_EXECUTION_CONFIG,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  resolveModelTokenLimits,
  type ContextConfig,
} from '../../config/runtime-config.js';
import type { AgentJob } from '../../domain/index.js';
import { ReactExecution } from '../../runtime/execution/react-execution.js';
import { ReActContextService } from '../../runtime/context/react-context.service.js';
import { AuditedModelFactory } from '../../runtime/model/audited-model.factory.js';
import { RuntimeError } from '../../runtime/errors/runtime-error.js';
import type { RuntimeEventPublisher } from '../../runtime/events/runtime-event-writer.js';
import type { RuntimeTool } from '../../runtime/execution/tool-executor.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { buildStableEnvironmentContext } from '../../runtime/prompting/job-agent-prompt.js';
import { ExecutionOwnershipService } from './shared/execution-ownership.service.js';
import { InterruptedJobScanner } from './shared/interrupted-job-scanner.js';
import { JobStateTransitions } from './shared/job-state-transitions.js';

export interface JobExecutionSupervisorPort {
  start(): Promise<void>;
  startExecution(jobId: string): Promise<void>;
  abortExecution(jobId: string): void;
  shutdown(): Promise<void>;
}

export interface JobExecutionSupervisorOptions {
  store: AgentStore;
  workerId: string;
  publisher: RuntimeEventPublisher;
  model: BaseChatModel;
  provider: string;
  modelName: string;
  tools: RuntimeTool[];
  sandboxRoot?: string;
  shellPath?: string;
  maxContextTokens?: number;
  reservedOutputTokens?: number;
  inputTokenLimit?: number;
  maxIterations?: number;
  maxToolCalls?: number;
  executionDeadlineMs?: number;
  jobLeaseMs?: number;
  jobHeartbeatMs?: number;
  recoveryIntervalMs?: number;
  recoveryBatchSize?: number;
  streaming?: boolean;
  contextConfig?: ContextConfig;
  jobSystemPrompt: string;
  systemPromptVersion: string;
  promptId: string;
  promptVersion: number;
  clock?: { nowMs(): number };
}

/**
 * Supervises process-local Job execution: recovery scans, active promises,
 * cancellation and execution ownership heartbeats. User-facing Job commands
 * belong to JobManager; ReAct mechanics remain in Runtime.
 */
export class JobExecutionSupervisor implements JobExecutionSupervisorPort {
  readonly #activeExecutions = new Map<string, {
    controller: AbortController;
    completion: Promise<void>;
  }>();
  readonly #options: Required<Omit<JobExecutionSupervisorOptions,
    'store' | 'publisher' | 'model' | 'tools' | 'workerId' | 'provider' | 'modelName'
    | 'sandboxRoot' | 'shellPath' | 'contextConfig'>>
    & JobExecutionSupervisorOptions;
  readonly #reactExecution: ReactExecution;
  readonly #contextService: ReActContextService;
  readonly #jobState: JobStateTransitions;
  readonly #executionOwnership: ExecutionOwnershipService;
  readonly #interruptedJobScanner: InterruptedJobScanner;
  #stopping = false;

  constructor(options: JobExecutionSupervisorOptions) {
    const defaultModelLimits = resolveModelTokenLimits(DEFAULT_MODEL_CONFIG);
    const maxContextTokens = options.maxContextTokens
      ?? defaultModelLimits.contextWindowTokens;
    const reservedOutputTokens = options.reservedOutputTokens
      ?? defaultModelLimits.outputTokenLimit;
    const inputTokenLimit = options.inputTokenLimit
      ?? maxContextTokens - reservedOutputTokens;
    this.#options = {
      maxContextTokens,
      reservedOutputTokens,
      inputTokenLimit,
      maxIterations: DEFAULT_EXECUTION_CONFIG.maxIterations,
      maxToolCalls: DEFAULT_EXECUTION_CONFIG.maxToolCalls,
      executionDeadlineMs: DEFAULT_EXECUTION_CONFIG.deadlineMs,
      jobLeaseMs: DEFAULT_EXECUTION_CONFIG.ownershipTimeoutMs,
      jobHeartbeatMs: DEFAULT_EXECUTION_CONFIG.ownershipRefreshMs,
      recoveryIntervalMs: DEFAULT_EXECUTION_CONFIG.recoveryScanIntervalMs,
      recoveryBatchSize: DEFAULT_EXECUTION_CONFIG.recoveryBatchSize,
      streaming: DEFAULT_MODEL_CONFIG.streaming,
      shellPath: DEFAULT_TOOLS_CONFIG.shell.executable,
      clock: { nowMs: () => Date.now() },
      ...options,
    };
    if (this.#options.jobHeartbeatMs >= this.#options.jobLeaseMs) {
      throw new RangeError('jobHeartbeatMs must be shorter than jobLeaseMs.');
    }
    if (!Number.isSafeInteger(this.#options.recoveryIntervalMs)
      || this.#options.recoveryIntervalMs <= 0) {
      throw new RangeError('recoveryIntervalMs must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.#options.recoveryBatchSize)
      || this.#options.recoveryBatchSize <= 0) {
      throw new RangeError('recoveryBatchSize must be a positive integer.');
    }
    this.#jobState = new JobStateTransitions({
      store: this.#options.store,
      workerId: this.#options.workerId,
      jobLeaseMs: this.#options.jobLeaseMs,
      clock: this.#options.clock,
    });
    this.#executionOwnership = new ExecutionOwnershipService({
      store: this.#options.store,
      jobState: this.#jobState,
      workerId: this.#options.workerId,
      refreshIntervalMs: this.#options.jobHeartbeatMs,
    });
    this.#interruptedJobScanner = new InterruptedJobScanner({
      store: this.#options.store,
      jobState: this.#jobState,
      publisher: this.#options.publisher,
      scanIntervalMs: this.#options.recoveryIntervalMs,
      batchSize: this.#options.recoveryBatchSize,
      clock: this.#options.clock,
    });
    const modelBudget = {
      provider: this.#options.provider,
      name: this.#options.modelName,
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
      inputTokenLimit: this.#options.inputTokenLimit,
    };
    // 普通 ReAct 与 Context 压缩共享同一个审计模型工厂；Supervisor 不感知具体调用类型。
    const modelFactory = new AuditedModelFactory({
      delegate: this.#options.model,
      store: this.#options.store,
      workerId: this.#options.workerId,
      provider: this.#options.provider,
      modelName: this.#options.modelName,
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
      publisher: this.#options.publisher,
    });
    this.#reactExecution = new ReactExecution({
      store: this.#options.store,
      jobState: {
        getJob: jobId => this.#jobState.getJob(jobId),
        failJob: (job, error) => this.#jobState.fail(job, error),
        cancelJob: (jobId, expectedVersion) => this.#jobState.cancel(jobId, expectedVersion),
      },
      workerId: this.#options.workerId,
      publisher: this.#options.publisher,
      modelFactory,
      tools: this.#options.tools,
      sandboxRoot: this.#options.sandboxRoot,
      maxIterations: this.#options.maxIterations,
      maxToolCalls: this.#options.maxToolCalls,
      executionDeadlineMs: this.#options.executionDeadlineMs,
      streaming: this.#options.streaming,
    });
    this.#contextService = new ReActContextService({
      store: this.#options.store,
      systemPrompt: this.#options.jobSystemPrompt,
      systemPromptVersion: this.#options.systemPromptVersion,
      promptId: this.#options.promptId,
      promptVersion: this.#options.promptVersion,
      model: modelBudget,
      contextConfig: this.#options.contextConfig ?? DEFAULT_CONTEXT_CONFIG,
      toolSchemas: this.#options.tools.map(tool => tool.tool),
      getStableContext: sessionId => buildStableEnvironmentContext({
        sandboxRoot: this.#options.sandboxRoot ?? '.agent-sandbox',
        sessionId,
        shellPath: this.#options.shellPath,
      }),
      // ReActContextService 内部决定何时以 context.compress 类型调用模型。
      modelFactory,
    });
  }

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#interruptedJobScanner.start();
  }

  async startExecution(jobId: string): Promise<void> {
    if (this.#stopping) return;
    const existingExecution = this.#activeExecutions.get(jobId);
    if (existingExecution) return existingExecution.completion;
    const execution = {
      controller: new AbortController(),
      completion: Promise.resolve(),
    };
    this.#activeExecutions.set(jobId, execution);
    execution.completion = this.#runJobWithExecutionOwnership(
      jobId,
      execution.controller.signal
    ).finally(() => {
      if (this.#activeExecutions.get(jobId) === execution) {
        this.#activeExecutions.delete(jobId);
      }
    });
    return execution.completion;
  }

  abortExecution(jobId: string): void {
    this.#activeExecutions.get(jobId)?.controller.abort();
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    await this.#interruptedJobScanner.stop();
    const activeExecutions = [...this.#activeExecutions.values()];
    for (const execution of activeExecutions) execution.controller.abort('runtime_shutdown');
    await Promise.allSettled(activeExecutions.map(execution => execution.completion));
  }

  async #runJobWithExecutionOwnership(jobId: string, signal: AbortSignal): Promise<void> {
    // Job 执行期间持续刷新执行权有效期；进程退出后刷新自然停止，过期 Job 会进入恢复流程。
    const stopOwnershipRefresh = this.#executionOwnership.startRefreshing(jobId);
    try {
      await this.#executeJob(jobId, signal);
    } catch (error) {
      if (!(error instanceof RuntimeError && ['lease_lost', 'aborted'].includes(error.code))) {
        await this.#failJobIfStillOwned(jobId, error);
      }
    } finally {
      stopOwnershipRefresh();
    }
  }

  async #executeJob(jobId: string, signal: AbortSignal): Promise<void> {
    // 先确认 Job 仍处于可运行状态，并且执行权、Attempt 都属于当前 Worker。
    const job = await this.#loadRunnableOwnedJob(jobId);
    await this.#reactExecution.runJob({
      job,
      // ReAct 每轮模型调用前都会执行该回调。上一轮工具结果、Plan 更新、HITL 回答
      // 已经写入数据库，因此这里必须重新构建 Context，而不能复用 Job 启动时的快照。
      reloadContext: () => this.#contextService.buildForJob(job),
      signal,
    });
  }

  async #loadRunnableOwnedJob(jobId: string): Promise<AgentJob> {
    const job = await this.#options.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} was not found.`);
    if (!['running', 'resuming'].includes(job.status)
      || job.leaseOwner !== this.#options.workerId
      || !job.currentAttemptId
      || !job.leaseExpiresAtMs
      || job.leaseExpiresAtMs <= this.#options.clock.nowMs()) {
      throw new RuntimeError('lease_lost', `Job ${jobId} is not owned by this worker.`);
    }
    return job;
  }

  async #failJobIfStillOwned(jobId: string, error: unknown): Promise<void> {
    const job = await this.#options.store.getJob(jobId);
    if (!job || !job.currentAttemptId || job.leaseOwner !== this.#options.workerId
      || !['running', 'resuming'].includes(job.status)) return;
    try {
      const failedJob = await this.#jobState.fail(job, {
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
