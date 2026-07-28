import type { Pool } from 'pg';
import type {
  AgentArtifact,
  AgentMessage,
  AgentSession,
  AgentTask,
  AgentTaskRun,
  AgentToolCall,
  AgentToolRun,
  AgentUserInputRequest,
} from '../../../domain/index.js';
import type {
  BeginSessionDeletionInput,
  BeginSessionDeletionResult,
  CreateSessionInput,
  SessionStore,
} from '../../agent-store.js';
import { beginSessionDeletionCommand, createSessionCommand } from '../transaction-commands.js';
import {
  mapAgentArtifactRow,
  mapAgentMessageRow,
  mapAgentSessionRow,
  mapAgentTaskRow,
  mapAgentTaskRunRow,
  mapAgentToolCallRow,
  mapAgentToolRunRow,
  mapAgentUserInputRequestRow,
  type AgentArtifactRow,
  type AgentMessageRow,
  type AgentSessionRow,
  type AgentTaskRow,
  type AgentTaskRunRow,
  type AgentToolCallRow,
  type AgentToolRunRow,
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
      `select * from agent_sessions order by updated_at_ms desc, id`
    );
    return result.rows.map(mapAgentSessionRow);
  }

  async beginDeletion(input: BeginSessionDeletionInput): Promise<BeginSessionDeletionResult> {
    return withPostgresClient(this.pool, client => beginSessionDeletionCommand(client, input));
  }

  async finalizeDeletion(sessionId: string): Promise<boolean> {
    const result = await this.pool.query(
      `delete from agent_sessions where id = $1 and status = 'archived'`,
      [sessionId]
    );
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
      `select * from agent_messages
       where session_id = $1 and row_id > $2
       order by row_id`,
      [sessionId, afterRowId]
    );
    return result.rows.map(mapAgentMessageRow);
  }

  async listTasks(sessionId: string): Promise<AgentTask[]> {
    const result = await this.pool.query<AgentTaskRow>(
      `select * from agent_tasks
       where session_id = $1 order by created_at_ms, id`,
      [sessionId]
    );
    return result.rows.map(mapAgentTaskRow);
  }

  async listTaskRuns(sessionId: string): Promise<AgentTaskRun[]> {
    const result = await this.pool.query<AgentTaskRunRow>(
      `select run.*
       from agent_task_runs run
       join agent_tasks task on task.id = run.task_id
       where task.session_id = $1
       order by task.created_at_ms, run.run_no`,
      [sessionId]
    );
    return result.rows.map(mapAgentTaskRunRow);
  }

  async listToolCalls(sessionId: string): Promise<AgentToolCall[]> {
    const result = await this.pool.query<AgentToolCallRow>(
      `select * from agent_tool_calls
       where session_id = $1 order by created_at_ms, id`,
      [sessionId]
    );
    return result.rows.map(mapAgentToolCallRow);
  }

  async listToolRuns(sessionId: string): Promise<AgentToolRun[]> {
    const result = await this.pool.query<AgentToolRunRow>(
      `select run.*
       from agent_tool_runs run
       join agent_tasks task on task.id = run.task_id
       where task.session_id = $1
       order by run.started_at_ms, run.id`,
      [sessionId]
    );
    return result.rows.map(mapAgentToolRunRow);
  }

  async listArtifacts(sessionId: string): Promise<AgentArtifact[]> {
    const result = await this.pool.query<AgentArtifactRow>(
      `select * from agent_artifacts
       where session_id = $1 order by created_at_ms, id`,
      [sessionId]
    );
    return result.rows.map(mapAgentArtifactRow);
  }

  async listUserInputRequests(sessionId: string): Promise<AgentUserInputRequest[]> {
    const result = await this.pool.query<AgentUserInputRequestRow>(
      `select * from agent_user_input_requests
       where session_id = $1 order by created_at_ms, id`,
      [sessionId]
    );
    return result.rows.map(mapAgentUserInputRequestRow);
  }
}
