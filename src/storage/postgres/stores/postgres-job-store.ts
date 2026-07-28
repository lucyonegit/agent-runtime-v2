import type { Pool } from 'pg';
import type { AgentJob } from '../../../domain/index.js';
import type {
  CancelJobInput,
  CreateJobAndAppendUserMessageInput,
  CreateJobAndAppendUserMessageResult,
  CreateRetryJobInput,
  CreateRetryJobResult,
  FailJobInput,
  JobStore,
  ListJobsNeedingRuntimeRecoveryInput,
  MarkJobRecoveryRequiredInput,
  RenewJobExecutionLeaseInput,
  StartJobExecutionInput,
} from '../../agent-store.js';
import {
  cancelJobCommand,
  createJobAndAppendUserMessageCommand,
  createRetryJobCommand,
  failJobCommand,
  markJobRecoveryRequiredCommand,
  renewJobExecutionLeaseCommand,
  startJobExecutionCommand,
} from '../transaction-commands.js';
import {
  mapAgentJobRow,
  type AgentJobRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

export class PostgresJobStore implements JobStore {
  constructor(private readonly pool: Pool) {}

  async get(jobId: string): Promise<AgentJob | undefined> {
    const result = await this.pool.query<AgentJobRow>(
      `select * from agent_jobs where id = $1`,
      [jobId]
    );
    return result.rows[0] ? mapAgentJobRow(result.rows[0]) : undefined;
  }

  async getByClientRequestId(
    sessionId: string,
    clientRequestId: string
  ): Promise<AgentJob | undefined> {
    const result = await this.pool.query<AgentJobRow>(
      `select *
       from agent_jobs
       where session_id = $1 and client_request_id = $2`,
      [sessionId, clientRequestId]
    );
    return result.rows[0] ? mapAgentJobRow(result.rows[0]) : undefined;
  }

  async listNeedingRecovery(
    input: ListJobsNeedingRuntimeRecoveryInput
  ): Promise<AgentJob[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new RangeError('Recovery batch limit must be a positive safe integer.');
    }
    const result = await this.pool.query<AgentJobRow>(
      `select *
       from agent_jobs
       where (status = 'created' and created_at_ms <= $3)
          or (
            status in ('running', 'resuming')
            and lease_expires_at_ms <= $1
          )
       order by coalesce(lease_expires_at_ms, created_at_ms) asc, created_at_ms asc, id asc
       limit $2`,
      [input.nowMs, input.limit, input.createdBeforeMs]
    );
    return result.rows.map(mapAgentJobRow);
  }

  async markRecoveryRequired(input: MarkJobRecoveryRequiredInput): Promise<AgentJob> {
    return withPostgresClient(
      this.pool,
      client => markJobRecoveryRequiredCommand(client, input)
    );
  }

  async createWithUserMessage(
    input: CreateJobAndAppendUserMessageInput
  ): Promise<CreateJobAndAppendUserMessageResult> {
    return withPostgresClient(
      this.pool,
      client => createJobAndAppendUserMessageCommand(client, input)
    );
  }

  async createRetry(input: CreateRetryJobInput): Promise<CreateRetryJobResult> {
    return withPostgresClient(this.pool, client => createRetryJobCommand(client, input));
  }

  async startExecution(input: StartJobExecutionInput): Promise<AgentJob> {
    return withPostgresClient(this.pool, client => startJobExecutionCommand(client, input));
  }

  async renewExecutionOwnership(input: RenewJobExecutionLeaseInput): Promise<AgentJob> {
    return withPostgresClient(
      this.pool,
      client => renewJobExecutionLeaseCommand(client, input)
    );
  }

  async fail(input: FailJobInput): Promise<AgentJob> {
    return withPostgresClient(this.pool, client => failJobCommand(client, input));
  }

  async cancel(input: CancelJobInput): Promise<AgentJob> {
    return withPostgresClient(this.pool, client => cancelJobCommand(client, input));
  }
}
