import type { Pool } from 'pg';
import type { AgentActivePlan } from '../../../domain/index.js';
import type { ApplyActivePlanInput, PlanStore } from '../../agent-store.js';
import { applyActivePlanCommand } from '../transaction-commands.js';
import {
  mapAgentActivePlanRow,
  type AgentActivePlanRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

export class PostgresPlanStore implements PlanStore {
  constructor(private readonly pool: Pool) {}

  async getActive(sessionId: string): Promise<AgentActivePlan | undefined> {
    const result = await this.pool.query<AgentActivePlanRow>(
      `select * from agent_active_plans where session_id = $1`,
      [sessionId]
    );
    return result.rows[0] ? mapAgentActivePlanRow(result.rows[0]) : undefined;
  }

  async apply(input: ApplyActivePlanInput): Promise<AgentActivePlan> {
    return withPostgresClient(this.pool, client => applyActivePlanCommand(client, input));
  }

  async clear(sessionId: string, taskId: string): Promise<boolean> {
    const result = await this.pool.query(
      `delete from agent_active_plans where session_id = $1 and task_id = $2`,
      [sessionId, taskId]
    );
    return result.rowCount === 1;
  }
}
