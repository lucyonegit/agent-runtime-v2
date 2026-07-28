import type { Pool } from 'pg';
import type {
  AgentContextOwnerType,
  AgentContextPurpose,
  AgentContextSummary,
} from '../../../domain/index.js';
import type {
  ContextStore,
  ReplaceContextSummaryInput,
} from '../../agent-store.js';
import { replaceContextSummaryCommand } from '../transaction-commands.js';
import {
  mapAgentContextSummaryRow,
  type AgentContextSummaryRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

export class PostgresContextStore implements ContextStore {
  constructor(private readonly pool: Pool) {}

  async listActiveSummaries(
    ownerType: AgentContextOwnerType,
    ownerId: string,
    purpose: AgentContextPurpose,
    contextRulesVersion: string
  ): Promise<AgentContextSummary[]> {
    const result = await this.pool.query<AgentContextSummaryRow>(
      `select * from agent_context_summaries
       where owner_type = $1 and owner_id = $2 and purpose = $3
         and context_rules_version = $4 and status = 'active'
       order by source_row_id_end desc, id asc`,
      [ownerType, ownerId, purpose, contextRulesVersion]
    );
    return result.rows.map(mapAgentContextSummaryRow);
  }

  async getSummariesByIds(ids: string[]): Promise<AgentContextSummary[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query<AgentContextSummaryRow>(
      `select * from agent_context_summaries where id = any($1::text[])`,
      [ids]
    );
    const byId = new Map(result.rows.map(row => {
      const summary = mapAgentContextSummaryRow(row);
      return [summary.id, summary] as const;
    }));
    return ids.flatMap(id => {
      const summary = byId.get(id);
      return summary ? [summary] : [];
    });
  }

  async replaceSummary(input: ReplaceContextSummaryInput): Promise<AgentContextSummary> {
    return withPostgresClient(this.pool, client => replaceContextSummaryCommand(client, input));
  }
}
