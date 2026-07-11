import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AgentRuntime } from '../orchestration/agent-runtime.js';
import { PostgresAgentStore } from '../storage/postgres/postgres-agent-store.js';
import { assertAgentRuntimeSchemaVersion } from '../storage/postgres/migrations.js';
import { AgentHttpModule } from './http/agent-http.module.js';
import { AGENT_CORS_OPTIONS } from './http/cors-options.js';
import { RuntimeExceptionFilter } from './http/runtime-exception.filter.js';
import { removeSessionSandbox } from '../tools/index.js';
import { createDefaultTools } from './runtime/default-tools.js';
import { RuntimeJobExecutionService } from './runtime/job-execution.service.js';
import { createLangChainChatModel } from './runtime/langchain-model-provider.js';
import { resolveModelRuntimeConfig } from './runtime/model-config.js';
import { RuntimeEventBus } from './runtime/runtime-event-bus.js';

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
await store.abandonStartedModelCalls(Date.now());
const events = new RuntimeEventBus();
const modelConfig = resolveModelRuntimeConfig(process.env);
const model = createLangChainChatModel(modelConfig);
const sandboxRoot = process.env.AGENT_SANDBOX_ROOT ?? '.agent-sandbox';
const jobLeaseMs = numberEnv('JOB_LEASE_MS', 20 * 60_000);
const jobHeartbeatMs = numberEnv('JOB_HEARTBEAT_MS', Math.max(1_000, Math.floor(jobLeaseMs / 3)));
if (jobHeartbeatMs >= jobLeaseMs) throw new Error('JOB_HEARTBEAT_MS must be shorter than JOB_LEASE_MS.');
const executor = new RuntimeJobExecutionService({
  store,
  workerId,
  publisher: events,
  model,
  provider: modelConfig.provider,
  modelName: modelConfig.modelName,
  tools: createDefaultTools(),
  sandboxRoot,
  maxContextTokens: numberEnv('MODEL_MAX_CONTEXT_TOKENS', 128_000),
  reservedOutputTokens: numberEnv('MODEL_RESERVED_OUTPUT_TOKENS', 4_096),
  jobLeaseMs,
  jobHeartbeatMs,
});
const runtime = new AgentRuntime({
  store,
  workerId,
  publisher: events,
  executor,
  jobLeaseMs,
  removeSessionWorkspace: sessionId => removeSessionSandbox({ sandboxRoot, sessionId }),
});
const app = await NestFactory.create<NestFastifyApplication>(
  AgentHttpModule.forRoot(runtime, events),
  new FastifyAdapter(),
  { logger: ['error', 'warn', 'log'] }
);
app.useGlobalFilters(new RuntimeExceptionFilter());
app.enableCors(AGENT_CORS_OPTIONS);
app.enableShutdownHooks();
const port = numberEnv('PORT', 3000);
await app.listen(port, process.env.HOST ?? '127.0.0.1');

const shutdown = async () => {
  await app.close();
  await pool.end();
};
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
