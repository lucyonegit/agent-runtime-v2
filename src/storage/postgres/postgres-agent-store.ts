import type { Pool, PoolClient } from 'pg';
import type { AgentJob, AgentMessage, AgentSession } from '../../domain/index.js';
import type {
  AgentStore,
  CancelJobInput,
  ClaimJobInput,
  CreateJobAndAppendUserMessageInput,
  CreateJobAndAppendUserMessageResult,
  CreateSessionInput,
  FailJobInput,
  RenewJobLeaseInput,
} from '../agent-store.js';
import {
  cancelJobCommand,
  claimJobCommand,
  createJobAndAppendUserMessageCommand,
  createSessionCommand,
  failJobCommand,
  renewJobLeaseCommand,
} from './transaction-commands.js';
import {
  mapAgentJobRow,
  mapAgentMessageRow,
  mapAgentSessionRow,
  type AgentJobRow,
  type AgentMessageRow,
  type AgentSessionRow,
} from './row-mappers.js';

export class PostgresAgentStore implements AgentStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async createSession(input: CreateSessionInput): Promise<AgentSession> {
    return this.#withClient(client => createSessionCommand(client, input));
  }

  async getSession(sessionId: string): Promise<AgentSession | undefined> {
    const result = await this.#pool.query<AgentSessionRow>(
      `select * from agent_sessions where id = $1`,
      [sessionId]
    );
    return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : undefined;
  }

  async getJob(jobId: string): Promise<AgentJob | undefined> {
    const result = await this.#pool.query<AgentJobRow>(
      `select * from agent_jobs where id = $1`,
      [jobId]
    );
    return result.rows[0] ? mapAgentJobRow(result.rows[0]) : undefined;
  }

  async listSessionMessages(sessionId: string, afterRowId = 0): Promise<AgentMessage[]> {
    const result = await this.#pool.query<AgentMessageRow>(
      `select *
       from agent_messages
       where session_id = $1 and row_id > $2
       order by row_id asc`,
      [sessionId, afterRowId]
    );
    return result.rows.map(mapAgentMessageRow);
  }

  async createJobAndAppendUserMessage(
    input: CreateJobAndAppendUserMessageInput
  ): Promise<CreateJobAndAppendUserMessageResult> {
    return this.#withClient(client => createJobAndAppendUserMessageCommand(client, input));
  }

  async claimJob(input: ClaimJobInput): Promise<AgentJob> {
    return this.#withClient(client => claimJobCommand(client, input));
  }

  async renewJobLease(input: RenewJobLeaseInput): Promise<AgentJob> {
    return this.#withClient(client => renewJobLeaseCommand(client, input));
  }

  async failJob(input: FailJobInput): Promise<AgentJob> {
    return this.#withClient(client => failJobCommand(client, input));
  }

  async cancelJob(input: CancelJobInput): Promise<AgentJob> {
    return this.#withClient(client => cancelJobCommand(client, input));
  }

  async #withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }
}
