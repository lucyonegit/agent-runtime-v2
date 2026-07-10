import { Pool } from 'pg';
import { migrateAgentRuntimeSchema } from '../src/storage/postgres/migrations.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for Agent Runtime schema migration.');
}

const pool = new Pool({ connectionString: databaseUrl });
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
