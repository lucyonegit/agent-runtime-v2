import type { Pool } from 'pg';
import type { AgentPlan, AgentPlanStep } from '../../../domain/index.js';
import type {
  ApplyPlanUpdateInput,
  ApplyPlanUpdateResult,
  PlanStore,
} from '../../agent-store.js';
import { applyPlanUpdateCommand } from '../transaction-commands.js';
import {
  mapAgentPlanRow,
  mapAgentPlanStepRow,
  type AgentPlanRow,
  type AgentPlanStepRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

export class PostgresPlanStore implements PlanStore {
  constructor(private readonly pool: Pool) {}

  async getByJobId(jobId: string): Promise<AgentPlan | undefined> {
    const result = await this.pool.query<AgentPlanRow>(
      `select * from agent_plans where job_id = $1`,
      [jobId]
    );
    return result.rows[0] ? mapAgentPlanRow(result.rows[0]) : undefined;
  }

  async listSteps(planId: string): Promise<AgentPlanStep[]> {
    const result = await this.pool.query<AgentPlanStepRow>(
      `select * from agent_plan_steps where plan_id = $1 order by position asc`,
      [planId]
    );
    return result.rows.map(mapAgentPlanStepRow);
  }

  async applyUpdate(input: ApplyPlanUpdateInput): Promise<ApplyPlanUpdateResult> {
    return withPostgresClient(this.pool, client => applyPlanUpdateCommand(client, input));
  }
}
