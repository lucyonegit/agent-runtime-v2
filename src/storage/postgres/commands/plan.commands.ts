import type { PoolClient } from 'pg';
import { AgentStoreError, type ApplyActivePlanInput } from '../../agent-store.js';
import {
  mapAgentActivePlanRow,
  type AgentActivePlanRow,
} from '../row-mappers.js';
import { withPostgresTransaction } from '../sql.js';
import {
  assertTaskRunOwnership,
  requireRow,
  selectTask,
  selectTaskRun,
  taskNotFound,
  touchSession,
} from './command-helpers.js';

export async function applyActivePlanCommand(
  client: PoolClient,
  input: ApplyActivePlanInput
) {
  validatePlan(input);
  return withPostgresTransaction(client, async () => {
    const task = await selectTask(client, input.taskId, true);
    if (!task || task.session_id !== input.sessionId) throw taskNotFound(input.taskId);
    const taskRun = await selectTaskRun(client, input.taskRunId, true);
    assertTaskRunOwnership(task, taskRun, input.ownerId, input.nowMs);
    const existingResult = await client.query<AgentActivePlanRow>(
      `select * from agent_active_plans where session_id = $1 for update`,
      [input.sessionId]
    );
    const existing = existingResult.rows[0];
    if (existing && existing.task_id !== input.taskId) {
      throw new AgentStoreError(
        'ACTIVE_TASK_CONFLICT',
        `Session ${JSON.stringify(input.sessionId)} has a plan owned by another Task.`,
        { sessionId: input.sessionId, taskId: input.taskId, planTaskId: existing.task_id }
      );
    }
    const result = existing
      ? await client.query<AgentActivePlanRow>(
          `update agent_active_plans
           set title = $2, steps = $3, version = version + 1, updated_at_ms = $4
           where session_id = $1
           returning *`,
          [input.sessionId, input.title.trim(), JSON.stringify(input.steps), input.nowMs]
        )
      : await client.query<AgentActivePlanRow>(
          `insert into agent_active_plans(
             session_id, task_id, title, steps, version, created_at_ms, updated_at_ms
           ) values ($1, $2, $3, $4, 0, $5, $5)
           returning *`,
          [
            input.sessionId,
            input.taskId,
            input.title.trim(),
            JSON.stringify(input.steps),
            input.nowMs,
          ]
        );
    await touchSession(client, input.sessionId, input.nowMs);
    return mapAgentActivePlanRow(requireRow(result.rows[0], 'apply active plan'));
  });
}

function validatePlan(input: ApplyActivePlanInput): void {
  if (!input.title.trim()) throw new TypeError('Plan title must not be empty.');
  if (input.steps.length === 0) throw new TypeError('Plan must contain at least one step.');
  if (input.steps.some(step => !step.step.trim())) {
    throw new TypeError('Plan step text must not be empty.');
  }
  if (input.steps.filter(step => step.status === 'in_progress').length > 1) {
    throw new TypeError('At most one Plan step may be in_progress.');
  }
}
