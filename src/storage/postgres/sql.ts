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
  const result = await client.query<{ id: string; status: string }>(
    `select id, status
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
  if (result.rows[0]!.status !== 'active') {
    throw new AgentStoreError(
      'INVALID_SESSION_STATE',
      `Agent session ${JSON.stringify(sessionId)} is not active.`,
      { sessionId, status: result.rows[0]!.status }
    );
  }
}

export async function lockAgentSessionForTask(
  client: PoolClient,
  taskId: string
): Promise<void> {
  const result = await client.query<{ id: string; status: string }>(
    `select session.id, session.status
     from agent_sessions session
     join agent_tasks task on task.session_id = session.id
     where task.id = $1
     for update of session`,
    [taskId]
  );
  if (result.rowCount !== 1) {
    throw new AgentStoreError(
      'TASK_NOT_FOUND',
      `Agent task ${JSON.stringify(taskId)} was not found.`,
      { taskId }
    );
  }
  if (result.rows[0]!.status !== 'active') {
    throw new AgentStoreError(
      'INVALID_SESSION_STATE',
      `Agent session ${JSON.stringify(result.rows[0]!.id)} is not active.`,
      { sessionId: result.rows[0]!.id, taskId, status: result.rows[0]!.status }
    );
  }
}
