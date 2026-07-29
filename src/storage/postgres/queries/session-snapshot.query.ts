import type { PoolClient } from 'pg';
import { AgentStoreError, type AgentSessionSnapshot } from '../../agent-store.js';
import {
  mapAgentActivePlanRow,
  mapAgentArtifactRow,
  mapAgentMessageRow,
  mapAgentModelUsageStatsRow,
  mapAgentSessionRow,
  mapAgentTaskRow,
  mapAgentTaskRunRow,
  mapAgentToolCallRow,
  mapAgentUserInputRequestRow,
  type AgentActivePlanRow,
  type AgentArtifactRow,
  type AgentMessageRow,
  type AgentModelUsageStatsRow,
  type AgentSessionRow,
  type AgentTaskRow,
  type AgentTaskRunRow,
  type AgentToolCallRow,
  type AgentUserInputRequestRow,
} from '../row-mappers.js';
import { withPostgresReadSnapshot } from '../sql.js';

/** Reads every durable SessionView projection from one MVCC snapshot. */
export function loadSessionSnapshotQuery(
  client: PoolClient,
  sessionId: string
): Promise<AgentSessionSnapshot> {
  return withPostgresReadSnapshot(client, async () => {
    const sessionResult = await client.query<AgentSessionRow>(
      `select * from agent_sessions where id = $1`,
      [sessionId]
    );
    const session = sessionResult.rows[0];
    if (!session) {
      throw new AgentStoreError(
        'SESSION_NOT_FOUND',
        `Agent session ${JSON.stringify(sessionId)} was not found.`,
        { sessionId }
      );
    }
    const taskResult = await client.query<AgentTaskRow>(
      `select * from agent_tasks
       where session_id = $1 order by created_at_ms, id`,
      [sessionId]
    );
    const taskRunResult = await client.query<AgentTaskRunRow>(
      `select run.*
       from agent_task_runs run
       join agent_tasks task on task.id = run.task_id
       where task.session_id = $1
       order by task.created_at_ms, run.run_no`,
      [sessionId]
    );
    const planResult = await client.query<AgentActivePlanRow>(
      `select * from agent_active_plans where session_id = $1`,
      [sessionId]
    );
    const messageResult = await client.query<AgentMessageRow>(
      `select * from agent_messages
       where session_id = $1 order by row_id`,
      [sessionId]
    );
    const toolCallResult = await client.query<AgentToolCallRow>(
      `select * from agent_tool_calls
       where session_id = $1 order by created_at_ms, id`,
      [sessionId]
    );
    const artifactResult = await client.query<AgentArtifactRow>(
      `select * from agent_artifacts
       where session_id = $1 order by created_at_ms, id`,
      [sessionId]
    );
    const requestResult = await client.query<AgentUserInputRequestRow>(
      `select * from agent_user_input_requests
       where session_id = $1 order by created_at_ms, id`,
      [sessionId]
    );
    const usageResult = await client.query<AgentModelUsageStatsRow>(
      `select * from agent_model_usage_stats where session_id = $1`,
      [sessionId]
    );
    return {
      session: mapAgentSessionRow(session),
      tasks: taskResult.rows.map(mapAgentTaskRow),
      taskRuns: taskRunResult.rows.map(mapAgentTaskRunRow),
      ...(planResult.rows[0] ? { activePlan: mapAgentActivePlanRow(planResult.rows[0]) } : {}),
      messages: messageResult.rows.map(mapAgentMessageRow),
      toolCalls: toolCallResult.rows.map(mapAgentToolCallRow),
      artifacts: artifactResult.rows.map(mapAgentArtifactRow),
      userInputRequests: requestResult.rows.map(mapAgentUserInputRequestRow),
      ...(usageResult.rows[0] ? { modelUsage: mapAgentModelUsageStatsRow(usageResult.rows[0]) } : {}),
    };
  });
}
