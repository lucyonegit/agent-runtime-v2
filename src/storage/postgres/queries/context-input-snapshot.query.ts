import type { PoolClient } from 'pg';
import {
  AgentStoreError,
  type AgentContextSnapshot,
} from '../../agent-store.js';
import {
  mapAgentActivePlanRow,
  mapAgentContextCompactionRow,
  mapAgentMessageRow,
  type AgentActivePlanRow,
  type AgentContextCompactionRow,
  type AgentMessageRow,
} from '../row-mappers.js';
import { withPostgresReadSnapshot } from '../sql.js';

/** Reads every durable model-input source from one MVCC snapshot. */
export function loadContextInputSnapshotQuery(
  client: PoolClient,
  sessionId: string
): Promise<AgentContextSnapshot> {
  return withPostgresReadSnapshot(client, async () => {
    const sessionResult = await client.query<{ status: string }>(
      `select status from agent_sessions where id = $1`,
      [sessionId]
    );
    const session = sessionResult.rows[0];
    if (!session) {
      throw new AgentStoreError(
        'SESSION_NOT_FOUND',
        `Agent session ${JSON.stringify(sessionId)} was not found.`,
        { sessionId }
      );
    }
    if (session.status !== 'active') {
      throw new AgentStoreError(
        'INVALID_SESSION_STATE',
        `Agent session ${JSON.stringify(sessionId)} is not active.`,
        { sessionId, status: session.status }
      );
    }
    const messageResult = await client.query<AgentMessageRow>(
      `select * from agent_messages
       where session_id = $1 order by row_id`,
      [sessionId]
    );
    const compactionResult = await client.query<AgentContextCompactionRow>(
      `select * from agent_context_compactions where session_id = $1`,
      [sessionId]
    );
    const planResult = await client.query<AgentActivePlanRow>(
      `select * from agent_active_plans where session_id = $1`,
      [sessionId]
    );
    return {
      messages: messageResult.rows.map(mapAgentMessageRow),
      ...(planResult.rows[0] ? { activePlan: mapAgentActivePlanRow(planResult.rows[0]) } : {}),
      ...(compactionResult.rows[0]
        ? { compaction: mapAgentContextCompactionRow(compactionResult.rows[0]) }
        : {}),
    };
  });
}
