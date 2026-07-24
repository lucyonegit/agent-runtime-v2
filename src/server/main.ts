import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { AgentRuntime } from '../orchestration/agent-runtime.js';
import { JobExecutionSupervisor } from '../orchestration/job-execution-supervisor.js';
import { JobManager } from '../orchestration/job-manager.js';
import { PostgresAgentStore } from '../storage/postgres/postgres-agent-store.js';
import { assertAgentRuntimeSchemaVersion } from '../storage/postgres/migrations.js';
import { AgentHttpModule } from './http/agent-http.module.js';
import { RuntimeExceptionFilter } from './http/runtime-exception.filter.js';
import { ContextPreviewService } from './debug/context-preview.service.js';
import { ManagedProcessManager, removeSessionSandbox } from '../tools/index.js';
import { createDefaultTools } from './runtime/default-tools.js';
import { createLangChainChatModel } from './runtime/langchain-model-provider.js';
import { RuntimeEventBus } from './runtime/runtime-event-bus.js';
import {
  JOB_AGENT_PROMPT_ID,
  JOB_AGENT_PROMPT_VERSION,
  JOB_AGENT_SYSTEM_PROMPT,
  JOB_AGENT_SYSTEM_PROMPT_VERSION,
} from '../runtime/prompting/job-agent-prompt.js';

const config = loadRuntimeConfig();
const pool = new Pool({
  connectionString: config.postgres.url,
  max: config.postgres.maxConnections,
  idleTimeoutMillis: config.postgres.idleTimeoutMs,
  connectionTimeoutMillis: config.postgres.connectionTimeoutMs,
  ssl: config.postgres.ssl,
});
const schemaClient = await pool.connect();
try {
  await assertAgentRuntimeSchemaVersion(schemaClient);
} finally {
  schemaClient.release();
}

const store = new PostgresAgentStore(pool);
const events = new RuntimeEventBus();
const managedProcesses = new ManagedProcessManager(
  events,
  { nowMs: () => Date.now() },
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
const jobExecutionSupervisor = new JobExecutionSupervisor({
  store,
  workerId: config.workerId,
  publisher: events,
  model,
  provider: config.model.provider,
  modelName: config.model.modelName,
  tools,
  sandboxRoot: config.sandboxRoot,
  shellPath: config.tools.shell.executable,
  maxContextTokens: config.modelTokenLimits.contextWindowTokens,
  reservedOutputTokens: config.modelTokenLimits.outputTokenLimit,
  inputTokenLimit: config.modelTokenLimits.inputTokenLimit,
  maxIterations: config.execution.maxIterations,
  maxToolCalls: config.execution.maxToolCalls,
  executionDeadlineMs: config.execution.deadlineMs,
  jobLeaseMs: config.execution.ownershipTimeoutMs,
  jobHeartbeatMs: config.execution.ownershipRefreshMs,
  recoveryIntervalMs: config.execution.recoveryScanIntervalMs,
  recoveryBatchSize: config.execution.recoveryBatchSize,
  streaming: config.model.streaming,
  contextConfig: config.context,
  jobSystemPrompt: JOB_AGENT_SYSTEM_PROMPT,
  systemPromptVersion: JOB_AGENT_SYSTEM_PROMPT_VERSION,
  promptId: JOB_AGENT_PROMPT_ID,
  promptVersion: JOB_AGENT_PROMPT_VERSION,
});
const jobs = new JobManager({
  store,
  publisher: events,
  execution: jobExecutionSupervisor,
  workerId: config.workerId,
  limits: {
    jobLeaseMs: config.execution.ownershipTimeoutMs,
    jobHeartbeatMs: config.execution.ownershipRefreshMs,
  },
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
});
await managedProcesses.start();
await runtime.start();
const app = await NestFactory.create<NestFastifyApplication>(
  AgentHttpModule.forRoot(runtime, events, contextPreview, managedProcesses),
  new FastifyAdapter(),
  { logger: config.server.logger }
);
app.useGlobalFilters(new RuntimeExceptionFilter());
app.enableCors(config.server.cors);
app.enableShutdownHooks();
await app.listen(config.server.port, config.server.host);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => shutdownPromise ??= (async () => {
  await runtime.stop();
  managedProcesses.shutdown();
  await app.close();
  await pool.end();
})();
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
