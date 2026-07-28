import type { PoolClient } from 'pg';
import {
  AgentStoreError,
  type AgentContextSnapshot,
  type LoadAgentContextSnapshotInput,
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
  input: LoadAgentContextSnapshotInput
): Promise<AgentContextSnapshot> {
  return withPostgresReadSnapshot(client, async () => {
    const sessionResult = await client.query<{ status: string }>(
      `select status from agent_sessions where id = $1`,
      [input.sessionId]
    );
    const session = sessionResult.rows[0];
    if (!session) {
      throw new AgentStoreError(
        'SESSION_NOT_FOUND',
        `Agent session ${JSON.stringify(input.sessionId)} was not found.`,
        { sessionId: input.sessionId }
      );
    }
    if (session.status !== 'active') {
      throw new AgentStoreError(
        'INVALID_SESSION_STATE',
        `Agent session ${JSON.stringify(input.sessionId)} is not active.`,
        { sessionId: input.sessionId, status: session.status }
      );
    }
    const compactionResult = await client.query<AgentContextCompactionRow>(
      `select * from agent_context_compactions where session_id = $1`,
      [input.sessionId]
    );
    const compaction = compactionResult.rows[0]
      ? mapAgentContextCompactionRow(compactionResult.rows[0])
      : undefined;
    const messageResult = await client.query<AgentMessageRow>(
      `select * from agent_messages
       where session_id = $1
         and (
           (context_scope = 'conversation' and (row_id > $4 or id = $3))
           or (context_scope = 'task' and task_id = $2)
         )
         and message_type <> 'progress'
         and channel is distinct from 'progress'
       order by row_id`,
      [
        input.sessionId,
        input.taskId,
        input.goalMessageId,
        compaction?.throughMessageRowId ?? 0,
      ]
    );
    const planResult = await client.query<AgentActivePlanRow>(
      `select * from agent_active_plans where session_id = $1`,
      [input.sessionId]
    );
    return {
      messages: messageResult.rows.map(mapAgentMessageRow),
      ...(planResult.rows[0] ? { activePlan: mapAgentActivePlanRow(planResult.rows[0]) } : {}),
      ...(compaction ? { compaction } : {}),
    };
  });
}
