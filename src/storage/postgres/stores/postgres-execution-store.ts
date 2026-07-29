import type { Pool } from 'pg';
import type {
  AgentToolCall,
  AgentUserInputRequest,
} from '../../../domain/index.js';
import type {
  CompleteTaskWithFinalMessageInput,
  CompleteTaskWithFinalMessageResult,
  CompleteToolCallInput,
  CompleteToolCallResult,
  ExecutionStore,
  ExpireUserInputRequestInput,
  ExpireUserInputRequestResult,
  SaveToolCallsInput,
  SaveToolCallsResult,
  SaveUserInputAnswerInput,
  SaveUserInputAnswerResult,
  StartToolCallInput,
  StartToolCallResult,
  TaskExecutionProgress,
  WaitForUserInputInput,
  WaitForUserInputResult,
} from '../../agent-store.js';
import {
  answerUserInputCommand,
  expireUserInputCommand,
  completeTaskCommand,
  completeToolCallCommand,
  saveToolCallsCommand,
  startToolCallCommand,
  waitForUserInputCommand,
} from '../transaction-commands.js';
import {
  mapAgentToolCallRow,
  mapAgentUserInputRequestRow,
  type AgentToolCallRow,
  type AgentUserInputRequestRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

export class PostgresExecutionStore implements ExecutionStore {
  constructor(private readonly pool: Pool) {}

  async getToolCall(taskId: string, modelToolCallId: string): Promise<AgentToolCall | undefined> {
    const result = await this.pool.query<AgentToolCallRow>(
      `select * from agent_tool_calls
       where task_id = $1 and model_tool_call_id = $2`,
      [taskId, modelToolCallId]
    );
    return result.rows[0] ? mapAgentToolCallRow(result.rows[0]) : undefined;
  }

  async getTaskProgress(taskId: string): Promise<TaskExecutionProgress> {
    const result = await this.pool.query<{ model_calls: number; tool_calls: number }>(
      `select
         (select count(*)::integer from agent_model_calls
          where task_id = $1 and call_type = 'task.react') as model_calls,
         (select count(*)::integer from agent_tool_calls
          where task_id = $1) as tool_calls`,
      [taskId]
    );
    const progress = result.rows[0];
    return {
      modelCalls: progress?.model_calls ?? 0,
      toolCalls: progress?.tool_calls ?? 0,
    };
  }

  async saveToolCalls(input: SaveToolCallsInput): Promise<SaveToolCallsResult> {
    return withPostgresClient(this.pool, client => saveToolCallsCommand(client, input));
  }

  async startToolCall(input: StartToolCallInput): Promise<StartToolCallResult> {
    return withPostgresClient(this.pool, client => startToolCallCommand(client, input));
  }

  async completeToolCall(input: CompleteToolCallInput): Promise<CompleteToolCallResult> {
    return withPostgresClient(this.pool, client => completeToolCallCommand(client, input));
  }

  async completeTask(
    input: CompleteTaskWithFinalMessageInput
  ): Promise<CompleteTaskWithFinalMessageResult> {
    return withPostgresClient(this.pool, client => completeTaskCommand(client, input));
  }

  async waitForUserInput(input: WaitForUserInputInput): Promise<WaitForUserInputResult> {
    return withPostgresClient(this.pool, client => waitForUserInputCommand(client, input));
  }

  async answerUserInput(input: SaveUserInputAnswerInput): Promise<SaveUserInputAnswerResult> {
    return withPostgresClient(this.pool, client => answerUserInputCommand(client, input));
  }

  async listExpiredUserInputRequests(
    nowMs: number,
    limit: number
  ): Promise<AgentUserInputRequest[]> {
    const result = await this.pool.query<AgentUserInputRequestRow>(
      `select request.*
       from agent_user_input_requests request
       join agent_tasks task on task.id = request.task_id
       where request.status = 'pending'
         and request.expires_at_ms is not null
         and request.expires_at_ms <= $1
         and task.status = 'waiting_for_user'
       order by request.expires_at_ms asc, request.id asc
       limit $2`,
      [nowMs, limit]
    );
    return result.rows.map(mapAgentUserInputRequestRow);
  }

  async expireUserInput(
    input: ExpireUserInputRequestInput
  ): Promise<ExpireUserInputRequestResult> {
    return withPostgresClient(this.pool, client => expireUserInputCommand(client, input));
  }
}
