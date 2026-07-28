import type { Pool } from 'pg';
import type {
  AgentArtifact,
  AgentJob,
  AgentMessage,
  AgentPlan,
  AgentPlanStep,
  AgentSession,
  AgentToolInvocation,
  AgentUserInputRequest,
} from '../../../domain/index.js';
import type { CreateSessionInput, SessionStore } from '../../agent-store.js';
import { createSessionCommand } from '../transaction-commands.js';
import {
  mapAgentArtifactRow,
  mapAgentJobRow,
  mapAgentMessageRow,
  mapAgentPlanRow,
  mapAgentPlanStepRow,
  mapAgentSessionRow,
  mapAgentToolInvocationRow,
  mapAgentUserInputRequestRow,
  type AgentArtifactRow,
  type AgentJobRow,
  type AgentMessageRow,
  type AgentPlanRow,
  type AgentPlanStepRow,
  type AgentSessionRow,
  type AgentToolInvocationRow,
  type AgentUserInputRequestRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateSessionInput): Promise<AgentSession> {
    return withPostgresClient(this.pool, client => createSessionCommand(client, input));
  }

  async list(): Promise<AgentSession[]> {
    const result = await this.pool.query<AgentSessionRow>(
      `select * from agent_sessions order by updated_at_ms desc, id asc`
    );
    return result.rows.map(mapAgentSessionRow);
  }

  async delete(sessionId: string): Promise<boolean> {
    const result = await this.pool.query(`delete from agent_sessions where id = $1`, [sessionId]);
    return result.rowCount === 1;
  }

  async get(sessionId: string): Promise<AgentSession | undefined> {
    const result = await this.pool.query<AgentSessionRow>(
      `select * from agent_sessions where id = $1`,
      [sessionId]
    );
    return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : undefined;
  }

  async listMessages(sessionId: string, afterRowId = 0): Promise<AgentMessage[]> {
    const result = await this.pool.query<AgentMessageRow>(
      `select *
       from agent_messages
       where session_id = $1 and row_id > $2
       order by row_id asc`,
      [sessionId, afterRowId]
    );
    return result.rows.map(mapAgentMessageRow);
  }

  async listJobs(sessionId: string): Promise<AgentJob[]> {
    const result = await this.pool.query<AgentJobRow>(
      `select * from agent_jobs where session_id = $1 order by created_at_ms asc, id asc`,
      [sessionId]
    );
    return result.rows.map(mapAgentJobRow);
  }

  async listPlans(sessionId: string): Promise<AgentPlan[]> {
    const result = await this.pool.query<AgentPlanRow>(
      `select * from agent_plans where session_id = $1 order by created_at_ms asc, id asc`,
      [sessionId]
    );
    return result.rows.map(mapAgentPlanRow);
  }

  async listPlanSteps(sessionId: string): Promise<AgentPlanStep[]> {
    const result = await this.pool.query<AgentPlanStepRow>(
      `select step.* from agent_plan_steps step
       join agent_plans plan on plan.id = step.plan_id
       where plan.session_id = $1
       order by plan.created_at_ms asc, step.position asc`,
      [sessionId]
    );
    return result.rows.map(mapAgentPlanStepRow);
  }

  async listToolInvocations(sessionId: string): Promise<AgentToolInvocation[]> {
    const result = await this.pool.query<AgentToolInvocationRow>(
      `select * from agent_tool_invocations where session_id = $1
       order by created_at_ms asc, id asc`,
      [sessionId]
    );
    return result.rows.map(mapAgentToolInvocationRow);
  }

  async listArtifacts(sessionId: string): Promise<AgentArtifact[]> {
    const result = await this.pool.query<AgentArtifactRow>(
      `select * from agent_artifacts where session_id = $1
       order by created_at_ms asc, id asc`,
      [sessionId]
    );
    return result.rows.map(mapAgentArtifactRow);
  }

  async listUserInputRequests(sessionId: string): Promise<AgentUserInputRequest[]> {
    const result = await this.pool.query<AgentUserInputRequestRow>(
      `select * from agent_user_input_requests where session_id = $1
       order by created_at_ms asc, id asc`,
      [sessionId]
    );
    return result.rows.map(mapAgentUserInputRequestRow);
  }
}
