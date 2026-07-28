import type { Pool } from 'pg';
import type { AgentContextCompaction } from '../../../domain/index.js';
import type {
  AgentContextSnapshot,
  ContextStore,
  ReplaceContextCompactionInput,
} from '../../agent-store.js';
import { replaceContextCompactionCommand } from '../transaction-commands.js';
import { loadContextInputSnapshotQuery } from '../queries/context-input-snapshot.query.js';
import {
  mapAgentContextCompactionRow,
  type AgentContextCompactionRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

export class PostgresContextStore implements ContextStore {
  constructor(private readonly pool: Pool) {}

  async loadInputSnapshot(sessionId: string): Promise<AgentContextSnapshot> {
    return withPostgresClient(
      this.pool,
      client => loadContextInputSnapshotQuery(client, sessionId)
    );
  }

  async getCompaction(sessionId: string): Promise<AgentContextCompaction | undefined> {
    const result = await this.pool.query<AgentContextCompactionRow>(
      `select * from agent_context_compactions where session_id = $1`,
      [sessionId]
    );
    return result.rows[0] ? mapAgentContextCompactionRow(result.rows[0]) : undefined;
  }

  async replaceCompaction(input: ReplaceContextCompactionInput): Promise<AgentContextCompaction> {
    return withPostgresClient(
      this.pool,
      client => replaceContextCompactionCommand(client, input)
    );
  }
}
