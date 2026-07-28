import type { Pool } from 'pg';
import type {
  AgentModelCall,
  AgentModelUsageStats,
} from '../../../domain/index.js';
import type {
  CompleteModelCallInput,
  CompleteModelCallResult,
  ModelStore,
  SetModelCallOutputDispositionInput,
  StartModelCallInput,
} from '../../agent-store.js';
import {
  abandonStartedModelCallsCommand,
  completeModelCallCommand,
  setModelCallOutputDispositionCommand,
  startModelCallCommand,
} from '../transaction-commands.js';
import {
  mapAgentModelCallRow,
  mapAgentModelUsageStatsRow,
  type AgentModelCallRow,
  type AgentModelUsageStatsRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

export class PostgresModelStore implements ModelStore {
  constructor(private readonly pool: Pool) {}

  async getCall(modelCallId: string): Promise<AgentModelCall | undefined> {
    const result = await this.pool.query<AgentModelCallRow>(
      `select * from agent_model_calls where id = $1`,
      [modelCallId]
    );
    return result.rows[0] ? mapAgentModelCallRow(result.rows[0]) : undefined;
  }

  async listCalls(jobId: string): Promise<AgentModelCall[]> {
    const result = await this.pool.query<AgentModelCallRow>(
      `select * from agent_model_calls where job_id = $1
       order by created_at_ms asc, call_attempt_no asc, logical_call_key asc, id asc`,
      [jobId]
    );
    return result.rows.map(mapAgentModelCallRow);
  }

  async listRecentSessionCalls(sessionId: string, limit: number): Promise<AgentModelCall[]> {
    const result = await this.pool.query<AgentModelCallRow>(
      `select * from agent_model_calls where session_id = $1
       order by created_at_ms desc, call_attempt_no desc, logical_call_key desc, id desc
       limit $2`,
      [sessionId, limit]
    );
    return result.rows.map(mapAgentModelCallRow).reverse();
  }

  async getUsageStats(sessionId: string): Promise<AgentModelUsageStats | undefined> {
    const result = await this.pool.query<AgentModelUsageStatsRow>(
      `select * from agent_model_usage_stats where session_id = $1`,
      [sessionId]
    );
    return result.rows[0] ? mapAgentModelUsageStatsRow(result.rows[0]) : undefined;
  }

  async startCall(input: StartModelCallInput): Promise<AgentModelCall> {
    return withPostgresClient(this.pool, client => startModelCallCommand(client, input));
  }

  async completeCall(input: CompleteModelCallInput): Promise<CompleteModelCallResult> {
    return withPostgresClient(this.pool, client => completeModelCallCommand(client, input));
  }

  async setCallOutputDisposition(
    input: SetModelCallOutputDispositionInput
  ): Promise<AgentModelCall> {
    return withPostgresClient(
      this.pool,
      client => setModelCallOutputDispositionCommand(client, input)
    );
  }

  async abandonStartedCalls(nowMs: number): Promise<AgentModelCall[]> {
    return withPostgresClient(this.pool, client => abandonStartedModelCallsCommand(client, nowMs));
  }
}
