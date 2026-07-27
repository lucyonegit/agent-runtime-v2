import type { PoolClient } from 'pg';
import type {
  AgentPlanStepResult
} from '../../../domain/index.js';
import {
  AgentStoreError,
  type ApplyPlanUpdateInput,
  type ApplyPlanUpdateResult
} from '../../agent-store.js';
import {
  mapAgentPlanRow,
  mapAgentPlanStepRow,
  type AgentJobRow,
  type AgentPlanRow,
  type AgentPlanStepRow
} from '../row-mappers.js';
import { lockAgentSession, withPostgresTransaction } from '../sql.js';
import {
  assertJobLease,
  requireRow,
  touchSession
} from './command-helpers.js';

export async function applyPlanUpdateCommand(
  client: PoolClient,
  input: ApplyPlanUpdateInput
): Promise<ApplyPlanUpdateResult> {
  validatePlanUpdate(input);

  return withPostgresTransaction(client, async () => {
    await lockAgentSession(client, input.sessionId);
    const jobResult = await client.query<AgentJobRow>(
      `select * from agent_jobs where id = $1 and session_id = $2 for update`,
      [input.jobId, input.sessionId]
    );
    const job = requireRow(jobResult.rows[0], 'lock job for plan update');
    assertJobLease(job, input.workerId, input.attemptId, input.nowMs);

    const planResult = await client.query<AgentPlanRow>(
      `select * from agent_plans where job_id = $1 for update`,
      [input.jobId]
    );
    const existingPlan = planResult.rows[0];
    if (!existingPlan && input.expectedVersion !== 0) {
      throw new AgentStoreError(
        'CONCURRENCY_CONFLICT',
        `Cannot create Plan because expected version ${input.expectedVersion} is stale.`,
        { jobId: input.jobId, expectedVersion: input.expectedVersion, actualVersion: 0 }
      );
    }
    if (existingPlan && existingPlan.id !== input.planId) {
      throw new AgentStoreError(
        'INVALID_PLAN_STATE',
        `Job ${JSON.stringify(input.jobId)} already owns Plan ${JSON.stringify(existingPlan.id)}.`,
        { jobId: input.jobId, planId: existingPlan.id }
      );
    }
    const incomingToolCallId = readMetadataString(input.metadata, 'lastToolCallId');
    const repeatedToolCall = existingPlan && incomingToolCallId !== undefined
      && readMetadataString(existingPlan.metadata, 'lastToolCallId') === incomingToolCallId;
    if (existingPlan && repeatedToolCall) {
      const replaySteps = await client.query<AgentPlanStepRow>(
        `select * from agent_plan_steps where plan_id = $1 order by position`,
        [existingPlan.id]
      );
      return {
        plan: mapAgentPlanRow(existingPlan),
        steps: replaySteps.rows.map(mapAgentPlanStepRow),
      };
    }
    if (existingPlan && existingPlan.version !== input.expectedVersion) {
      throw new AgentStoreError(
        'CONCURRENCY_CONFLICT',
        `Plan ${JSON.stringify(input.planId)} version ${input.expectedVersion} is stale.`,
        {
          planId: input.planId,
          expectedVersion: input.expectedVersion,
          actualVersion: existingPlan.version,
        }
      );
    }
    if (existingPlan && ['completed', 'failed', 'cancelled'].includes(existingPlan.status)) {
      throw new AgentStoreError(
        'INVALID_PLAN_STATE',
        `Plan ${JSON.stringify(input.planId)} is ${existingPlan.status}.`
      );
    }

    const currentStepsResult = existingPlan
      ? await client.query<AgentPlanStepRow>(
          `select * from agent_plan_steps where plan_id = $1 order by position for update`,
          [input.planId]
        )
      : { rows: [] as AgentPlanStepRow[] };
    const currentByKey = new Map(currentStepsResult.rows.map(step => [step.key, step]));
    const incomingByKey = new Map(input.steps.map(step => [step.key, step]));

    for (const current of currentStepsResult.rows) {
      const incoming = incomingByKey.get(current.key);
      if (!incoming) {
        throw new AgentStoreError(
          'INVALID_PLAN_STATE',
          `Plan update omitted existing step ${JSON.stringify(current.key)}; mark it skipped instead.`,
          { planId: input.planId, stepKey: current.key }
        );
      }
      if (incoming.id !== current.id) {
        throw new AgentStoreError(
          'INVALID_PLAN_STATE',
          `Plan step ${JSON.stringify(current.key)} must keep its durable ID.`,
          { stepKey: current.key, expectedId: current.id, actualId: incoming.id }
        );
      }
      if (
        ['completed', 'failed', 'skipped'].includes(current.status)
        && incoming.status !== current.status
      ) {
        throw new AgentStoreError(
          'INVALID_PLAN_STATE',
          `Terminal plan step ${JSON.stringify(current.key)} cannot return to ${incoming.status}.`,
          { stepKey: current.key, status: current.status }
        );
      }
    }

    for (const step of input.steps) {
      const sameId = currentStepsResult.rows.find(current => current.id === step.id);
      if (sameId && sameId.key !== step.key) {
        throw new AgentStoreError(
          'INVALID_PLAN_STATE',
          `Plan step ID ${JSON.stringify(step.id)} cannot be reassigned to another key.`,
          { stepId: step.id, expectedKey: sameId.key, actualKey: step.key }
        );
      }
    }

    const allTerminal = input.steps.every(step => isTerminalPlanStepStatus(step.status));
    const planStatus = allTerminal
      ? input.steps.some(step => step.status === 'failed') ? 'failed' : 'completed'
      : 'active';
    let planRow: AgentPlanRow;
    if (existingPlan) {
      const updated = await client.query<AgentPlanRow>(
        `update agent_plans
         set title = $2,
             goal = $3,
             status = $4,
             version = version + 1,
             metadata = $5,
             updated_at_ms = $6,
             completed_at_ms = case
               when $4::text in ('completed', 'failed') then $6::bigint
               else null::bigint
             end
         where id = $1
         returning *`,
        [
          input.planId,
          input.title,
          input.goal,
          planStatus,
          input.metadata ?? null,
          input.nowMs,
        ]
      );
      planRow = requireRow(updated.rows[0], 'update plan');
      await client.query(
        `update agent_plan_steps
         set position = position + 1000000
         where plan_id = $1`,
        [input.planId]
      );
    } else {
      const created = await client.query<AgentPlanRow>(
        `insert into agent_plans(
           id, session_id, job_id, title, goal, status, version, metadata,
           created_at_ms, updated_at_ms, completed_at_ms
         ) values (
           $1, $2, $3, $4, $5, $6, 0, $7,
           $8::bigint, $8::bigint,
           case when $6::text in ('completed', 'failed') then $8::bigint else null::bigint end
         )
         returning *`,
        [
          input.planId,
          input.sessionId,
          input.jobId,
          input.title,
          input.goal,
          planStatus,
          input.metadata ?? null,
          input.nowMs,
        ]
      );
      planRow = requireRow(created.rows[0], 'create plan');
    }

    const stepRows: AgentPlanStepRow[] = [];
    for (const step of input.steps) {
      const current = currentByKey.get(step.key);
      const completedAtMs = isTerminalPlanStepStatus(step.status)
        ? current?.completed_at_ms ?? input.nowMs
        : null;
      if (current) {
        const updated = await client.query<AgentPlanStepRow>(
          `update agent_plan_steps
           set position = $2,
               title = $3,
               description = $4,
               status = $5,
               result = $6,
               error_code = $7,
               error_message = $8,
               error_details = $9,
               version = version + 1,
               metadata = $10,
               updated_at_ms = $11,
               completed_at_ms = $12
           where id = $1
           returning *`,
          [
            current.id,
            step.position,
            step.title,
            step.description ?? null,
            step.status,
            serializePlanStepResult(
              step.result,
              mapAgentPlanStepRow(current).result
            ),
            step.error?.code ?? null,
            step.error?.message ?? null,
            step.error?.details ?? null,
            step.metadata ?? null,
            input.nowMs,
            completedAtMs,
          ]
        );
        stepRows.push(requireRow(updated.rows[0], 'update plan step'));
      } else {
        const created = await client.query<AgentPlanStepRow>(
          `insert into agent_plan_steps(
             id, plan_id, key, position, title, description, status, result,
             error_code, error_message, error_details, version, metadata,
             created_at_ms, updated_at_ms, completed_at_ms
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, 0, $12,
             $13, $13, $14
           )
           returning *`,
          [
            step.id,
            input.planId,
            step.key,
            step.position,
            step.title,
            step.description ?? null,
            step.status,
            step.result ? JSON.stringify(step.result) : null,
            step.error?.code ?? null,
            step.error?.message ?? null,
            step.error?.details ?? null,
            step.metadata ?? null,
            input.nowMs,
            completedAtMs,
          ]
        );
        stepRows.push(requireRow(created.rows[0], 'create plan step'));
      }
    }

    await touchSession(client, input.sessionId, input.nowMs);
    return {
      plan: mapAgentPlanRow(planRow),
      steps: stepRows.sort((left, right) => left.position - right.position).map(mapAgentPlanStepRow),
    };
  });
}

function mergePlanStepResult(
  incoming: AgentPlanStepResult | undefined,
  current: AgentPlanStepResult | undefined
): AgentPlanStepResult | undefined {
  if (!incoming && !current) return undefined;
  return {
    ...(incoming?.summary !== undefined
      ? { summary: incoming.summary }
      : current?.summary !== undefined ? { summary: current.summary } : {}),
    ...(current?.evidenceMessageIds?.length
      ? { evidenceMessageIds: current.evidenceMessageIds }
      : {}),
    ...(current?.artifactIds?.length ? { artifactIds: current.artifactIds } : {}),
  };
}

function serializePlanStepResult(
  incoming: AgentPlanStepResult | undefined,
  current: AgentPlanStepResult | undefined
): string | null {
  const merged = mergePlanStepResult(incoming, current);
  return merged ? JSON.stringify(merged) : null;
}

function validatePlanUpdate(input: ApplyPlanUpdateInput): void {
  if (input.steps.length === 0) {
    throw new TypeError('A Plan requires at least one step.');
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new RangeError('expectedVersion must be a non-negative safe integer.');
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const positions = new Set<number>();
  let inProgressCount = 0;
  for (const step of input.steps) {
    if (!step.id.trim() || !step.key.trim() || !step.title.trim()) {
      throw new TypeError('Plan steps require non-empty id, key, and title values.');
    }
    if (!Number.isSafeInteger(step.position) || step.position < 0) {
      throw new RangeError('Plan step positions must be non-negative safe integers.');
    }
    if (ids.has(step.id) || keys.has(step.key) || positions.has(step.position)) {
      throw new TypeError('Plan step IDs, keys, and positions must be unique.');
    }
    ids.add(step.id);
    keys.add(step.key);
    positions.add(step.position);
    if (step.status === 'in_progress') inProgressCount += 1;
  }
  const allTerminal = input.steps.every(step => isTerminalPlanStepStatus(step.status));
  if ((!allTerminal && inProgressCount !== 1) || (allTerminal && inProgressCount !== 0)) {
    throw new AgentStoreError(
      'INVALID_PLAN_STATE',
      'A Plan requires exactly one in-progress step until every step is terminal.'
    );
  }
}

function isTerminalPlanStepStatus(status: AgentPlanStepRow['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'skipped';
}

function readMetadataString(value: unknown, key: string): string | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)[key] === 'string'
    ? (value as Record<string, string>)[key]
    : undefined;
}
