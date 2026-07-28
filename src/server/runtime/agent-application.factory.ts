import { Pool } from 'pg';
import type { RuntimeConfig } from '../../config/runtime-config.js';
import { AgentRuntime } from '../../orchestration/agent-runtime.js';
import { JobExecutor } from '../../orchestration/jobs/job-executor.js';
import { JobManager } from '../../orchestration/jobs/job-manager.js';
import { JobStore } from '../../orchestration/jobs/shared/job-store.js';
import { ReActContextService } from '../../runtime/context/react-context.service.js';
import { ReActExecution } from '../../runtime/execution/react-execution.js';
import { AuditedModelFactory } from '../../runtime/model/audited-model.factory.js';
import {
  buildStableEnvironmentContext,
  JOB_AGENT_PROMPT_ID,
  JOB_AGENT_PROMPT_VERSION,
  JOB_AGENT_SYSTEM_PROMPT,
  JOB_AGENT_SYSTEM_PROMPT_VERSION,
} from '../../runtime/prompting/job-agent-prompt.js';
import { assertAgentRuntimeSchemaVersion } from '../../storage/postgres/migrations.js';
import { PostgresAgentStore } from '../../storage/postgres/postgres-agent-store.js';
import { ManagedProcessManager, removeSessionSandbox } from '../../tools/index.js';
import { ContextPreviewService } from '../debug/context-preview.service.js';
import { createDefaultTools } from './default-tools.js';
import { createLangChainChatModel } from './langchain-model-provider.js';
import { RuntimeEventBus } from './runtime-event-bus.js';

export interface AgentApplication {
  runtime: AgentRuntime;
  events: RuntimeEventBus;
  contextPreview: ContextPreviewService;
  managedProcesses: ManagedProcessManager;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Server composition root for the Agent application.
 *
 * This is the only place that knows concrete database, model, Context,
 * execution and orchestration implementations. Runtime classes receive their
 * collaborators and stay focused on their own behavior.
 */
export async function createAgentApplication(
  config: RuntimeConfig
): Promise<AgentApplication> {
  const pool = new Pool({
    connectionString: config.postgres.url,
    max: config.postgres.maxConnections,
    idleTimeoutMillis: config.postgres.idleTimeoutMs,
    connectionTimeoutMillis: config.postgres.connectionTimeoutMs,
    ssl: config.postgres.ssl,
  });

  try {
    const schemaClient = await pool.connect();
    try {
      await assertAgentRuntimeSchemaVersion(schemaClient);
    } finally {
      schemaClient.release();
    }

    const clock = { nowMs: () => Date.now() };
    const store = new PostgresAgentStore(pool);
    const events = new RuntimeEventBus();
    const managedProcesses = new ManagedProcessManager(
      events,
      clock,
      config.sandboxRoot,
      config.tools
    );
    const model = createLangChainChatModel(
      config.model,
      config.modelTokenLimits.outputTokenLimit
    );
    const tools = createDefaultTools({
      store,
      workerId: config.workerId,
      publisher: events,
      managedProcessManager: managedProcesses,
      toolsConfig: config.tools,
    });

    // JobManager、后台执行监督器和 ReAct 使用同一套状态迁移规则。
    const jobStore = new JobStore({
      store,
      workerId: config.workerId,
      jobLeaseMs: config.execution.ownershipTimeoutMs,
      clock,
    });
    const modelFactory = new AuditedModelFactory({
      delegate: model,
      store,
      workerId: config.workerId,
      provider: config.model.provider,
      modelName: config.model.modelName,
      maxContextTokens: config.modelTokenLimits.contextWindowTokens,
      reservedOutputTokens: config.modelTokenLimits.outputTokenLimit,
      publisher: events,
    });
    const context = new ReActContextService({
      store,
      systemPrompt: JOB_AGENT_SYSTEM_PROMPT,
      systemPromptVersion: JOB_AGENT_SYSTEM_PROMPT_VERSION,
      promptId: JOB_AGENT_PROMPT_ID,
      promptVersion: JOB_AGENT_PROMPT_VERSION,
      model: {
        provider: config.model.provider,
        name: config.model.modelName,
        maxContextTokens: config.modelTokenLimits.contextWindowTokens,
        reservedOutputTokens: config.modelTokenLimits.outputTokenLimit,
        inputTokenLimit: config.modelTokenLimits.inputTokenLimit,
      },
      contextConfig: config.context,
      toolSchemas: tools.map(tool => tool.tool),
      getStableContext: sessionId => buildStableEnvironmentContext({
        sandboxRoot: config.sandboxRoot,
        sessionId,
        shellPath: config.tools.shell.executable,
      }),
      modelFactory,
    });
    const reactExecution = new ReActExecution({
      store,
      jobStore,
      context,
      workerId: config.workerId,
      publisher: events,
      modelFactory,
      tools,
      sandboxRoot: config.sandboxRoot,
      maxIterations: config.execution.maxIterations,
      maxToolCalls: config.execution.maxToolCalls,
      executionDeadlineMs: config.execution.deadlineMs,
      streaming: config.model.streaming,
    });
    const jobExecutor = new JobExecutor({
      store,
      jobStore,
      reactExecution,
      workerId: config.workerId,
      publisher: events,
      ownershipTimeoutMs: config.execution.ownershipTimeoutMs,
      ownershipRefreshMs: config.execution.ownershipRefreshMs,
      recoveryIntervalMs: config.execution.recoveryScanIntervalMs,
      recoveryBatchSize: config.execution.recoveryBatchSize,
      clock,
    });
    const jobs = new JobManager({
      jobStore,
      publisher: events,
      execution: jobExecutor,
    });
    const contextPreview = new ContextPreviewService({
      store,
      tools,
      provider: config.model.provider,
      modelName: config.model.modelName,
      maxContextTokens: config.modelTokenLimits.contextWindowTokens,
      reservedOutputTokens: config.modelTokenLimits.outputTokenLimit,
      inputTokenLimit: config.modelTokenLimits.inputTokenLimit,
      sandboxRoot: config.sandboxRoot,
      shellPath: config.tools.shell.executable,
      contextConfig: config.context,
      clock,
    });
    const runtime = new AgentRuntime({
      store,
      jobs,
      processReader: managedProcesses,
      beforeDeleteSession: sessionId => managedProcesses.stopSessionProcesses(sessionId),
      removeSessionWorkspace: sessionId => removeSessionSandbox({
        sandboxRoot: config.sandboxRoot,
        sessionId,
      }),
      clock,
    });

    return {
      runtime,
      events,
      contextPreview,
      managedProcesses,
      async start() {
        await managedProcesses.start();
        try {
          await runtime.start();
        } catch (error) {
          managedProcesses.shutdown();
          throw error;
        }
      },
      async stop() {
        try {
          await runtime.stop();
        } finally {
          managedProcesses.shutdown();
        }
      },
      async dispose() {
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
