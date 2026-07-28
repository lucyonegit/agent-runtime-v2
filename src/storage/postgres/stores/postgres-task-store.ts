import type { Pool } from 'pg';
import type { AgentTask, AgentTaskRun } from '../../../domain/index.js';
import type {
  CancelTaskInput,
  CreateRetryTaskInput,
  CreateRetryTaskResult,
  CreateTaskWithUserMessageInput,
  CreateTaskWithUserMessageResult,
  FailTaskInput,
  FinishTaskResult,
  ListTasksNeedingRecoveryInput,
  MarkTaskRecoveryRequiredInput,
  MarkTaskRecoveryRequiredResult,
  RenewTaskRunOwnershipInput,
  StartTaskRunInput,
  StartTaskRunResult,
  TaskRecoveryCandidate,
  TaskStore,
} from '../../agent-store.js';
import {
  cancelTaskCommand,
  createRetryTaskCommand,
  createTaskWithUserMessageCommand,
  failTaskCommand,
  markTaskRecoveryRequiredCommand,
  renewTaskRunOwnershipCommand,
  startTaskRunCommand,
} from '../transaction-commands.js';
import {
  mapAgentTaskRow,
  mapAgentTaskRunRow,
  type AgentTaskRow,
  type AgentTaskRunRow,
} from '../row-mappers.js';
import { withPostgresClient } from './postgres-store.helper.js';

interface RecoveryRow extends AgentTaskRow {
  run_id: string | null;
  run_task_id: string | null;
  run_run_no: number | null;
  run_trigger: string | null;
  run_status: string | null;
  run_owner_id: string | null;
  run_ownership_expires_at_ms: string | number | null;
  run_error_code: string | null;
  run_error_message: string | null;
  run_error_details: unknown;
  run_metadata: unknown;
  run_started_at_ms: string | number | null;
  run_updated_at_ms: string | number | null;
  run_ended_at_ms: string | number | null;
}

export class PostgresTaskStore implements TaskStore {
  constructor(private readonly pool: Pool) {}

  async get(taskId: string): Promise<AgentTask | undefined> {
    const result = await this.pool.query<AgentTaskRow>(
      `select * from agent_tasks where id = $1`,
      [taskId]
    );
    return result.rows[0] ? mapAgentTaskRow(result.rows[0]) : undefined;
  }

  async getByClientRequestId(
    sessionId: string,
    clientRequestId: string
  ): Promise<AgentTask | undefined> {
    const result = await this.pool.query<AgentTaskRow>(
      `select * from agent_tasks where session_id = $1 and client_request_id = $2`,
      [sessionId, clientRequestId]
    );
    return result.rows[0] ? mapAgentTaskRow(result.rows[0]) : undefined;
  }

  async getLatestRun(taskId: string): Promise<AgentTaskRun | undefined> {
    const result = await this.pool.query<AgentTaskRunRow>(
      `select * from agent_task_runs
       where task_id = $1
       order by run_no desc
       limit 1`,
      [taskId]
    );
    return result.rows[0] ? mapAgentTaskRunRow(result.rows[0]) : undefined;
  }

  async listNeedingRecovery(
    input: ListTasksNeedingRecoveryInput
  ): Promise<TaskRecoveryCandidate[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new RangeError('Recovery batch limit must be a positive safe integer.');
    }
    const result = await this.pool.query<RecoveryRow>(
      `select task.*,
              run.id as run_id,
              run.task_id as run_task_id,
              run.run_no as run_run_no,
              run.trigger as run_trigger,
              run.status as run_status,
              run.owner_id as run_owner_id,
              run.ownership_expires_at_ms as run_ownership_expires_at_ms,
              run.error_code as run_error_code,
              run.error_message as run_error_message,
              run.error_details as run_error_details,
              run.metadata as run_metadata,
              run.started_at_ms as run_started_at_ms,
              run.updated_at_ms as run_updated_at_ms,
              run.ended_at_ms as run_ended_at_ms
       from agent_tasks task
       left join agent_task_runs run
         on run.task_id = task.id and run.status = 'running'
       where (task.status = 'created' and task.created_at_ms <= $2)
          or (task.status = 'running' and run.ownership_expires_at_ms <= $1)
       order by coalesce(run.ownership_expires_at_ms, task.created_at_ms), task.id
       limit $3`,
      [input.nowMs, input.createdBeforeMs, input.limit]
    );
    return result.rows.map(row => ({
      task: mapAgentTaskRow(row),
      ...(row.run_id
        ? {
            taskRun: mapAgentTaskRunRow({
              id: row.run_id,
              task_id: row.run_task_id as string,
              run_no: row.run_run_no as number,
              trigger: row.run_trigger as string,
              status: row.run_status as string,
              owner_id: row.run_owner_id,
              ownership_expires_at_ms: row.run_ownership_expires_at_ms,
              error_code: row.run_error_code ?? null,
              error_message: row.run_error_message ?? null,
              error_details: row.run_error_details ?? null,
              metadata: row.run_metadata ?? null,
              started_at_ms: row.run_started_at_ms as string | number,
              updated_at_ms: row.run_updated_at_ms as string | number,
              ended_at_ms: row.run_ended_at_ms,
            }),
          }
        : {}),
    }));
  }

  async createWithUserMessage(
    input: CreateTaskWithUserMessageInput
  ): Promise<CreateTaskWithUserMessageResult> {
    return withPostgresClient(this.pool, client => createTaskWithUserMessageCommand(client, input));
  }

  async createRetry(input: CreateRetryTaskInput): Promise<CreateRetryTaskResult> {
    return withPostgresClient(this.pool, client => createRetryTaskCommand(client, input));
  }

  async startRun(input: StartTaskRunInput): Promise<StartTaskRunResult> {
    return withPostgresClient(this.pool, client => startTaskRunCommand(client, input));
  }

  async renewRunOwnership(input: RenewTaskRunOwnershipInput): Promise<AgentTaskRun> {
    return withPostgresClient(this.pool, client => renewTaskRunOwnershipCommand(client, input));
  }

  async markRecoveryRequired(
    input: MarkTaskRecoveryRequiredInput
  ): Promise<MarkTaskRecoveryRequiredResult> {
    return withPostgresClient(this.pool, client => markTaskRecoveryRequiredCommand(client, input));
  }

  async fail(input: FailTaskInput): Promise<FinishTaskResult> {
    return withPostgresClient(this.pool, client => failTaskCommand(client, input));
  }

  async cancel(input: CancelTaskInput): Promise<FinishTaskResult> {
    return withPostgresClient(this.pool, client => cancelTaskCommand(client, input));
  }
}
