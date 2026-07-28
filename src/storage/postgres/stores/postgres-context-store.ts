import type { Pool } from 'pg';
import type { AgentContextCompaction } from '../../../domain/index.js';
import type {
  ContextStore,
  ReplaceContextCompactionInput,
} from '../../agent-store.js';
import { replaceContextCompactionCommand } from '../transaction-commands.js';
import {
  mapAgentContextCompactionRow,
  type AgentContextCompactionRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

export class PostgresContextStore implements ContextStore {
  constructor(private readonly pool: Pool) {}

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
