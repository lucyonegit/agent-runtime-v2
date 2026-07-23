import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AgentRuntime } from '../orchestration/agent-runtime.js';
import { JobExecutionManager } from '../orchestration/job-execution-manager.js';
import { JobLifecycle } from '../orchestration/job-lifecycle.js';
import { PostgresAgentStore } from '../storage/postgres/postgres-agent-store.js';
import { assertAgentRuntimeSchemaVersion } from '../storage/postgres/migrations.js';
import { AgentHttpModule } from './http/agent-http.module.js';
import { AGENT_CORS_OPTIONS } from './http/cors-options.js';
import { RuntimeExceptionFilter } from './http/runtime-exception.filter.js';
import { ContextPreviewService } from './debug/context-preview.service.js';
import { ManagedProcessManager, removeSessionSandbox } from '../tools/index.js';
import { createDefaultTools } from './runtime/default-tools.js';
import { createLangChainChatModel } from './runtime/langchain-model-provider.js';
import { resolveModelRuntimeConfig } from './runtime/model-config.js';
import { resolveModelTokenLimits } from './runtime/model-token-limits.js';
import { RuntimeEventBus } from './runtime/runtime-event-bus.js';
import {
  JOB_AGENT_PROMPT_ID,
  JOB_AGENT_PROMPT_VERSION,
  JOB_AGENT_SYSTEM_PROMPT,
  JOB_AGENT_SYSTEM_PROMPT_VERSION,
} from '../runtime/prompting/job-agent-prompt.js';

const databaseUrl = requiredEnv('DATABASE_URL');
const workerId = process.env.AGENT_RUNTIME_WORKER_ID ?? `worker_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl });
const schemaClient = await pool.connect();
try {
  await assertAgentRuntimeSchemaVersion(schemaClient);
} finally {
  schemaClient.release();
}

const store = new PostgresAgentStore(pool);
const events = new RuntimeEventBus();
const modelConfig = resolveModelRuntimeConfig(process.env);
const modelTokenLimits = resolveModelTokenLimits(modelConfig, process.env);
const sandboxRoot = process.env.AGENT_SANDBOX_ROOT ?? '.agent-sandbox';
const managedProcesses = new ManagedProcessManager(
  events,
  { nowMs: () => Date.now() },
  sandboxRoot
);
const jobLeaseMs = numberEnv('JOB_LEASE_MS', 30_000);
const jobHeartbeatMs = numberEnv('JOB_HEARTBEAT_MS', Math.max(1_000, Math.floor(jobLeaseMs / 3)));
const jobRecoveryScanMs = numberEnv('JOB_RECOVERY_SCAN_MS', 5_000);
const model = createLangChainChatModel(modelConfig, modelTokenLimits.outputTokenLimit);
if (jobHeartbeatMs >= jobLeaseMs) throw new Error('JOB_HEARTBEAT_MS must be shorter than JOB_LEASE_MS.');
const jobLifecycle = new JobLifecycle({
  store,
  workerId,
  limits: { jobLeaseMs, jobHeartbeatMs },
});
const tools = createDefaultTools({
  store,
  workerId,
  publisher: events,
  managedProcessManager: managedProcesses,
});
const jobExecution = new JobExecutionManager({
  store,
  jobLifecycle,
  workerId,
  publisher: events,
  model,
  provider: modelConfig.provider,
  modelName: modelConfig.modelName,
  tools,
  sandboxRoot,
  maxContextTokens: modelTokenLimits.contextWindowTokens,
  reservedOutputTokens: modelTokenLimits.outputTokenLimit,
  inputTokenLimit: modelTokenLimits.inputTokenLimit,
  jobLeaseMs,
  jobHeartbeatMs,
  recoveryIntervalMs: jobRecoveryScanMs,
  jobSystemPrompt: JOB_AGENT_SYSTEM_PROMPT,
  systemPromptVersion: JOB_AGENT_SYSTEM_PROMPT_VERSION,
  promptId: JOB_AGENT_PROMPT_ID,
  promptVersion: JOB_AGENT_PROMPT_VERSION,
});
const contextPreview = new ContextPreviewService({
  store,
  tools,
  provider: modelConfig.provider,
  modelName: modelConfig.modelName,
  maxContextTokens: modelTokenLimits.contextWindowTokens,
  reservedOutputTokens: modelTokenLimits.outputTokenLimit,
  inputTokenLimit: modelTokenLimits.inputTokenLimit,
  sandboxRoot,
});
const runtime = new AgentRuntime({
  store,
  jobLifecycle,
  publisher: events,
  jobExecution,
  processReader: managedProcesses,
  beforeDeleteSession: sessionId => managedProcesses.stopSessionProcesses(sessionId),
  removeSessionWorkspace: sessionId => removeSessionSandbox({ sandboxRoot, sessionId }),
});
await managedProcesses.start();
await runtime.start();
const app = await NestFactory.create<NestFastifyApplication>(
  AgentHttpModule.forRoot(runtime, events, contextPreview, managedProcesses),
  new FastifyAdapter(),
  { logger: ['error', 'warn', 'log'] }
);
app.useGlobalFilters(new RuntimeExceptionFilter());
app.enableCors(AGENT_CORS_OPTIONS);
app.enableShutdownHooks();
const port = numberEnv('AGENT_SERVER_PORT', 3000);
await app.listen(port, process.env.AGENT_SERVER_HOST ?? '127.0.0.1');

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => shutdownPromise ??= (async () => {
  await runtime.stop();
  managedProcesses.shutdown();
  await app.close();
  await pool.end();
})();
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
