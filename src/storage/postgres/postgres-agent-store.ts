import type { Pool, PoolClient } from 'pg';
import type { AgentJob, AgentMessage, AgentSession, AgentToolInvocation } from '../../domain/index.js';
import type {
  AgentStore,
  CancelJobInput,
  ClaimJobInput,
  ClaimToolInvocationInput,
  ClaimToolInvocationResult,
  AnswerInputAndClaimResumeInput,
  AnswerInputAndClaimResumeResult,
  CommitModelToolCallsInput,
  CommitModelToolCallsResult,
  CommitToolResultInput,
  CommitToolResultResult,
  CompleteJobWithFinalMessageInput,
  CompleteJobWithFinalMessageResult,
  CreateInputRequestsAndMarkWaitingInput,
  CreateInputRequestsAndMarkWaitingResult,
  CreateJobAndAppendUserMessageInput,
  CreateJobAndAppendUserMessageResult,
  CreateSessionInput,
  FailJobInput,
  RenewJobLeaseInput,
} from '../agent-store.js';
import {
  cancelJobCommand,
  claimJobCommand,
  claimToolInvocationCommand,
  answerInputAndClaimResumeCommand,
  commitModelToolCallsCommand,
  commitToolResultCommand,
  completeJobWithFinalMessageCommand,
  createInputRequestsAndMarkWaitingCommand,
  createJobAndAppendUserMessageCommand,
  createSessionCommand,
  failJobCommand,
  renewJobLeaseCommand,
} from './transaction-commands.js';
import {
  mapAgentJobRow,
  mapAgentMessageRow,
  mapAgentSessionRow,
  mapAgentToolInvocationRow,
  type AgentJobRow,
  type AgentMessageRow,
  type AgentSessionRow,
  type AgentToolInvocationRow,
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

  async getJobByClientRequestId(
    sessionId: string,
    clientRequestId: string
  ): Promise<AgentJob | undefined> {
    const result = await this.#pool.query<AgentJobRow>(
      `select *
       from agent_jobs
       where session_id = $1 and client_request_id = $2`,
      [sessionId, clientRequestId]
    );
    return result.rows[0] ? mapAgentJobRow(result.rows[0]) : undefined;
  }

  async getToolInvocation(
    jobId: string,
    toolCallId: string
  ): Promise<AgentToolInvocation | undefined> {
    const result = await this.#pool.query<AgentToolInvocationRow>(
      `select *
       from agent_tool_invocations
       where job_id = $1 and tool_call_id = $2`,
      [jobId, toolCallId]
    );
    return result.rows[0] ? mapAgentToolInvocationRow(result.rows[0]) : undefined;
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

  async commitModelToolCalls(
    input: CommitModelToolCallsInput
  ): Promise<CommitModelToolCallsResult> {
    return this.#withClient(client => commitModelToolCallsCommand(client, input));
  }

  async claimToolInvocation(
    input: ClaimToolInvocationInput
  ): Promise<ClaimToolInvocationResult> {
    return this.#withClient(client => claimToolInvocationCommand(client, input));
  }

  async commitToolResult(input: CommitToolResultInput): Promise<CommitToolResultResult> {
    return this.#withClient(client => commitToolResultCommand(client, input));
  }

  async completeJobWithFinalMessage(
    input: CompleteJobWithFinalMessageInput
  ): Promise<CompleteJobWithFinalMessageResult> {
    return this.#withClient(client => completeJobWithFinalMessageCommand(client, input));
  }

  async createInputRequestsAndMarkWaiting(
    input: CreateInputRequestsAndMarkWaitingInput
  ): Promise<CreateInputRequestsAndMarkWaitingResult> {
    return this.#withClient(client => createInputRequestsAndMarkWaitingCommand(client, input));
  }

  async answerInputAndClaimResume(
    input: AnswerInputAndClaimResumeInput
  ): Promise<AnswerInputAndClaimResumeResult> {
    return this.#withClient(client => answerInputAndClaimResumeCommand(client, input));
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
