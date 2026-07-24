import 'dotenv/config';
import { Pool } from 'pg';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';
import {
  migrateAgentRuntimeSchema,
  resetAgentRuntimeSchema,
} from '../src/storage/postgres/migrations.js';

const CONFIRMATION_FLAG = '--confirm-agent-runtime-reset';
const environment = process.env.NODE_ENV ?? 'unknown';
const explicitlyAllowed = process.env.ALLOW_AGENT_RUNTIME_RESET === 'true';

if (!process.argv.includes(CONFIRMATION_FLAG)) {
  throw new Error(`Schema reset requires ${CONFIRMATION_FLAG}.`);
}
if (!['development', 'test'].includes(environment) && !explicitlyAllowed) {
  throw new Error(
    `Agent Runtime schema reset is disabled in NODE_ENV=${environment}; `
    + 'set ALLOW_AGENT_RUNTIME_RESET=true only for an intentional reset.'
  );
}

const config = loadRuntimeConfig();
const pool = new Pool({
  connectionString: config.postgres.url,
  max: config.postgres.maxConnections,
  idleTimeoutMillis: config.postgres.idleTimeoutMs,
  connectionTimeoutMillis: config.postgres.connectionTimeoutMs,
  ssl: config.postgres.ssl,
});
try {
  const client = await pool.connect();
  try {
    const droppedTables = await resetAgentRuntimeSchema(client);
    const version = await migrateAgentRuntimeSchema(client);
    console.info(
      `Agent Runtime schema reset completed: dropped=${droppedTables.length} version=${version.version}`
    );
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
