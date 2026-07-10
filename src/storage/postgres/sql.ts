import type { PoolClient } from 'pg';
import { AgentStoreError } from '../agent-store.js';

export async function withPostgresTransaction<T>(
  client: PoolClient,
  operation: () => Promise<T>
): Promise<T> {
  await client.query('begin');
  try {
    const result = await operation();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export async function lockAgentSession(
  client: PoolClient,
  sessionId: string
): Promise<void> {
  const result = await client.query(
    `select id
     from agent_sessions
     where id = $1
     for update`,
    [sessionId]
  );
  if (result.rowCount !== 1) {
    throw new AgentStoreError(
      'SESSION_NOT_FOUND',
      `Agent session ${JSON.stringify(sessionId)} was not found.`,
      { sessionId }
    );
  }
}
