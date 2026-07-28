import type { Pool } from 'pg';
import type {
  AgentLoopCheckpoint,
  AgentToolInvocation,
} from '../../../domain/index.js';
import type {
  CommitModelToolCallsInput,
  CommitModelToolCallsResult,
  CommitToolResultInput,
  CommitToolResultResult,
  CompleteJobWithFinalMessageInput,
  CompleteJobWithFinalMessageResult,
  CreateInputRequestsAndMarkWaitingInput,
  CreateInputRequestsAndMarkWaitingResult,
  ExecutionStore,
  PrepareToolInvocationsForRecoveryInput,
  PrepareToolInvocationsForRecoveryResult,
  SaveUserInputAnswerInput,
  SaveUserInputAnswerResult,
  TryStartToolExecutionInput,
  TryStartToolExecutionResult,
} from '../../agent-store.js';
import {
  commitModelToolCallsCommand,
  commitToolResultCommand,
  completeJobWithFinalMessageCommand,
  createInputRequestsAndMarkWaitingCommand,
  prepareToolInvocationsForRecoveryCommand,
  saveUserInputAnswerAndResumeIfReadyCommand,
  tryStartToolExecutionCommand,
} from '../transaction-commands.js';
import {
  mapAgentLoopCheckpointRow,
  mapAgentToolInvocationRow,
  type AgentLoopCheckpointRow,
  type AgentToolInvocationRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

export class PostgresExecutionStore implements ExecutionStore {
  constructor(private readonly pool: Pool) {}

  async getToolInvocation(
    jobId: string,
    toolCallId: string
  ): Promise<AgentToolInvocation | undefined> {
    const result = await this.pool.query<AgentToolInvocationRow>(
      `select *
       from agent_tool_invocations
       where job_id = $1 and tool_call_id = $2`,
      [jobId, toolCallId]
    );
    return result.rows[0] ? mapAgentToolInvocationRow(result.rows[0]) : undefined;
  }

  async getLatestLoopCheckpoint(jobId: string): Promise<AgentLoopCheckpoint | undefined> {
    const result = await this.pool.query<AgentLoopCheckpointRow>(
      `select * from agent_loop_checkpoints
       where job_id = $1
       order by sequence_no desc
       limit 1`,
      [jobId]
    );
    return result.rows[0] ? mapAgentLoopCheckpointRow(result.rows[0]) : undefined;
  }

  async commitModelToolCalls(
    input: CommitModelToolCallsInput
  ): Promise<CommitModelToolCallsResult> {
    return withPostgresClient(this.pool, client => commitModelToolCallsCommand(client, input));
  }

  async tryStartTool(
    input: TryStartToolExecutionInput
  ): Promise<TryStartToolExecutionResult> {
    return withPostgresClient(this.pool, client => tryStartToolExecutionCommand(client, input));
  }

  async prepareToolsForRecovery(
    input: PrepareToolInvocationsForRecoveryInput
  ): Promise<PrepareToolInvocationsForRecoveryResult> {
    return withPostgresClient(
      this.pool,
      client => prepareToolInvocationsForRecoveryCommand(client, input)
    );
  }

  async commitToolResult(input: CommitToolResultInput): Promise<CommitToolResultResult> {
    return withPostgresClient(this.pool, client => commitToolResultCommand(client, input));
  }

  async completeWithFinalMessage(
    input: CompleteJobWithFinalMessageInput
  ): Promise<CompleteJobWithFinalMessageResult> {
    return withPostgresClient(
      this.pool,
      client => completeJobWithFinalMessageCommand(client, input)
    );
  }

  async waitForUserInput(
    input: CreateInputRequestsAndMarkWaitingInput
  ): Promise<CreateInputRequestsAndMarkWaitingResult> {
    return withPostgresClient(
      this.pool,
      client => createInputRequestsAndMarkWaitingCommand(client, input)
    );
  }

  async answerUserInput(input: SaveUserInputAnswerInput): Promise<SaveUserInputAnswerResult> {
    return withPostgresClient(
      this.pool,
      client => saveUserInputAnswerAndResumeIfReadyCommand(client, input)
    );
  }
}
