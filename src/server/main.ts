import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { createAgentApplication } from './runtime/agent-application.factory.js';
import { AgentHttpModule } from './http/agent-http.module.js';
import { RuntimeExceptionFilter } from './http/runtime-exception.filter.js';
import { requireRuntimeHttpAuthToken } from './http/runtime-http-auth.guard.js';

const config = loadRuntimeConfig();
const authToken = requireRuntimeHttpAuthToken(config.server.authToken);
const application = await createAgentApplication(config);
await application.start();
const app = await NestFactory.create<NestFastifyApplication>(
  AgentHttpModule.forRoot(
    application.runtime,
    application.events,
    application.contextPreview,
    application.managedProcesses,
    authToken
  ),
  new FastifyAdapter(),
  { logger: config.server.logger }
);
app.useGlobalFilters(new RuntimeExceptionFilter());
app.enableCors(config.server.cors);
app.enableShutdownHooks();
await app.listen(config.server.port, config.server.host);

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => shutdownPromise ??= (async () => {
  await application.stop();
  await app.close();
  await application.dispose();
})();
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
