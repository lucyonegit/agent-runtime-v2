import type { Pool, PoolClient } from 'pg';

/** Borrow one PostgreSQL client for a command and always return it to the pool. */
export async function withPostgresClient<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}
