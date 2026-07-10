import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { AgentServerModule } from './http/server.module.js';
import { PostgresSessionStore, initializePostgresSessionStoreSchema } from '../storage/index.js';
import { createQwenRuntime } from './runtime/qwen-runtime.js';
import { AGENT_SERVER_PORT } from './server-config.js';

const databaseUrl = process.env.DATABASE_URL
  ?? 'postgresql://postgres:123456@127.0.0.1:5433/postgres';
const port = AGENT_SERVER_PORT;
const host = process.env.HOST ?? '127.0.0.1';
const sandboxRoot = resolve(process.env.AGENT_SANDBOX_ROOT ?? '.agent-sandbox');

async function bootstrap(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  await initializePostgresSessionStoreSchema(pool);

  const store = new PostgresSessionStore(pool);
  const runtime = await createQwenRuntime();
  const app = await NestFactory.create<NestFastifyApplication>(
    AgentServerModule.register({
      store,
      contextBuilder: runtime.contextBuilder,
      react: runtime.react,
      planner: runtime.planner,
      plannerStepReact: runtime.plannerStepReact,
      code: runtime.code,
      sandboxRoot,
      modelName: runtime.modelName,
    }),
    new FastifyAdapter(),
    {}
  );

  app.enableCors({
    origin: true,
  });

  app.enableShutdownHooks();
  process.once('SIGINT', () => {
    void pool.end();
  });
  process.once('SIGTERM', () => {
    void pool.end();
  });

  await app.listen(port, host);
  console.log(`Agent Runtime API listening on http://${host}:${port}`);
  console.log(`DATABASE_URL=${databaseUrl}`);
  console.log(`AGENT_SANDBOX_ROOT=${sandboxRoot}`);
  console.log('Runtime model: Qwen / DashScope');
}

bootstrap().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
