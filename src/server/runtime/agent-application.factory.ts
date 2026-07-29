import { Pool } from 'pg';
import type { RuntimeConfig } from '../../config/runtime-config.js';
import { AgentRuntime } from '../../orchestration/agent-runtime.js';
import { InterruptedTaskScanner } from '../../orchestration/tasks/shared/interrupted-task-scanner.js';
import { TaskExecutor } from '../../orchestration/tasks/task-executor.js';
import { TaskManager } from '../../orchestration/tasks/task-manager.js';
import { ModelInputBuilder } from '../../runtime/context/model-input-builder.js';
import { ReActExecution } from '../../runtime/execution/react-execution.js';
import { AuditedModelFactory } from '../../runtime/model/audited-model.factory.js';
import {
  buildStableEnvironmentContext,
  TASK_AGENT_PROMPT_ID,
  TASK_AGENT_PROMPT_VERSION,
  TASK_AGENT_SYSTEM_PROMPT,
  TASK_AGENT_SYSTEM_PROMPT_VERSION,
} from '../../runtime/prompting/task-agent-prompt.js';
import { assertAgentRuntimeSchema } from '../../storage/postgres/schema-management.js';
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
      await assertAgentRuntimeSchema(schemaClient);
    } finally {
      schemaClient.release();
    }

    const clock = { nowMs: () => Date.now() };
    const store = new PostgresAgentStore(pool);
    const events = new RuntimeEventBus({
      readSessionRevision: async sessionId => (await store.sessions.get(sessionId))?.version,
    });
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
    const context = new ModelInputBuilder({
      store,
      systemPrompt: TASK_AGENT_SYSTEM_PROMPT,
      systemPromptVersion: TASK_AGENT_SYSTEM_PROMPT_VERSION,
      promptId: TASK_AGENT_PROMPT_ID,
      promptVersion: TASK_AGENT_PROMPT_VERSION,
      inputTokenLimit: config.modelTokenLimits.inputTokenLimit,
      reservedOutputTokens: config.modelTokenLimits.outputTokenLimit,
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
      clock,
    });
    const taskExecutor = new TaskExecutor({
      store,
      reactExecution,
      workerId: config.workerId,
      publisher: events,
      ownershipTimeoutMs: config.execution.ownershipTimeoutMs,
      ownershipRefreshMs: config.execution.ownershipRefreshMs,
      clock,
    });
    const interruptedTaskScanner = new InterruptedTaskScanner({
      store,
      publisher: events,
      createdTaskGraceMs: config.execution.startupRecoveryGraceMs,
      batchSize: config.execution.recoveryBatchSize,
      clock,
      ownerId: config.workerId,
      ownershipTimeoutMs: config.execution.ownershipTimeoutMs,
      onTaskReady: command => {
        void taskExecutor.execute(command).catch(() => {
          // Ownership checks or another committed transition may win the startup race.
        });
      },
    });
    const tasks = new TaskManager({
      store,
      workerId: config.workerId,
      ownershipTimeoutMs: config.execution.ownershipTimeoutMs,
      publisher: events,
      execution: taskExecutor,
      clock,
    });
    const contextPreview = new ContextPreviewService({
      store,
      tools,
      contextWindowTokens: config.modelTokenLimits.contextWindowTokens,
      outputTokenLimit: config.modelTokenLimits.outputTokenLimit,
      inputTokenLimit: config.modelTokenLimits.inputTokenLimit,
      sandboxRoot: config.sandboxRoot,
      shellPath: config.tools.shell.executable,
      contextConfig: config.context,
      clock,
    });
    const runtime = new AgentRuntime({
      store,
      tasks,
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
        try {
          await managedProcesses.start();
          await interruptedTaskScanner.scanOnce();
        } catch (error) {
          await taskExecutor.shutdown();
          managedProcesses.shutdown();
          throw error;
        }
      },
      async stop() {
        try {
          await taskExecutor.shutdown();
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
