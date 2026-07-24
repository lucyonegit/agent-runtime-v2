import { Pool } from 'pg';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';
import { migrateAgentRuntimeSchema } from '../src/storage/postgres/migrations.js';

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
    const version = await migrateAgentRuntimeSchema(client);
    console.info(
      `Agent Runtime schema is ready: version=${version.version} name=${version.name}`
    );
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
