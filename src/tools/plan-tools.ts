import { randomUUID } from 'node:crypto';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { AgentPlanStepResult } from '../domain/index.js';
import type { RuntimeTool } from '../runtime/execution/tool-executor.js';
import { resolveJobGoalMessage } from '../runtime/job-goal.js';
import type { RuntimeEventPublisher } from '../runtime/runtime-event-writer.js';
import {
  jsonToolOutput,
  runtimeContext,
  stringArgument,
} from './helpers/tool-input.helper.js';
import type { CreatePlanToolsOptions } from './types/plan-tool.types.js';

export type { CreatePlanToolsOptions } from './types/plan-tool.types.js';

export function createPlanTools(options: CreatePlanToolsOptions): RuntimeTool[] {
  const clock = options.clock ?? { nowMs: () => Date.now() };
  const ids = options.ids ?? {
    planId: () => `plan_${randomUUID()}`,
    planStepId: () => `plan_step_${randomUUID()}`,
  };
  const updatePlan = new DynamicStructuredTool({
    name: 'update_plan',
    description: [
      'Create or replace the durable execution plan for the current Job.',
      'Use it for multi-step work, call it alone, and send the complete plan every time.',
      'Keep existing step keys stable. Mark finished steps completed with a result summary,',
      'mark removed work skipped, and keep exactly one step in_progress until all work is terminal.',
      'Terminal steps are immutable; add a new stable key when recovery work is required.',
      'Only provide result.summary; evidence message IDs and artifact IDs are attached by the runtime.',
    ].join(' '),
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short user-facing plan title.' },
        explanation: {
          type: 'string',
          description: 'Brief reason for creating or changing the plan.',
        },
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Stable machine-readable key; never change it after creation.',
              },
              title: { type: 'string' },
              description: { type: 'string' },
              status: {
                enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'],
              },
              result: {
                type: 'object',
                properties: {
                  summary: { type: 'string' },
                },
                // Some providers echo runtime-owned fields from a prior tool result.
                // Accept them at the LangChain boundary, then parseResult deliberately
                // projects only summary so the model can never own evidence/artifact IDs.
                additionalProperties: true,
              },
            },
            required: ['key', 'title', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'steps'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async (rawInput, _runManager, config) => {
      const context = runtimeContext(config);
      if (context.attemptId.length === 0) throw new Error('update_plan requires an active Job attempt.');
      const input = parsePlanInput(rawInput as Record<string, unknown>);
      const [job, messages, existingPlan] = await Promise.all([
        options.store.getJob(context.jobId),
        options.store.listSessionMessages(context.sessionId),
        options.store.getPlanByJobId(context.jobId),
      ]);
      if (!job || job.sessionId !== context.sessionId) {
        throw new Error(`Job ${JSON.stringify(context.jobId)} was not found.`);
      }
      const goal = resolveJobGoalMessage(job, messages)?.content;
      if (!goal) throw new Error(`Job ${JSON.stringify(job.id)} has no original user goal.`);
      const existingSteps = existingPlan
        ? await options.store.listPlanSteps(existingPlan.id)
        : [];
      const existingByKey = new Map(existingSteps.map(step => [step.key, step]));
      const result = await options.store.applyPlanUpdate({
        sessionId: context.sessionId,
        jobId: context.jobId,
        workerId: options.workerId,
        attemptId: context.attemptId,
        planId: existingPlan?.id ?? ids.planId(),
        expectedVersion: existingPlan?.version ?? 0,
        title: input.title,
        goal,
        steps: input.steps.map((step, position) => ({
          id: existingByKey.get(step.key)?.id ?? ids.planStepId(),
          key: step.key,
          position,
          title: step.title,
          description: step.description,
          status: step.status,
          result: step.result,
        })),
        metadata: {
          explanation: input.explanation,
          lastToolCallId: context.toolCallId,
        },
        nowMs: clock.nowMs(),
      });
      await safePublish(options.publisher, {
        type: 'plan.upserted',
        sessionId: context.sessionId,
        plan: result.plan,
      });
      for (const step of result.steps) {
        await safePublish(options.publisher, {
          type: 'plan_step.upserted',
          sessionId: context.sessionId,
          step,
        });
      }
      return jsonToolOutput({
        planId: result.plan.id,
        version: result.plan.version,
        status: result.plan.status,
        title: result.plan.title,
        steps: result.steps.map(step => ({
          key: step.key,
          title: step.title,
          status: step.status,
          result: step.result,
        })),
      });
    },
  });
  return [{
    tool: updatePlan,
    sideEffectLevel: 'idempotent',
    exclusive: true,
  }];
}

interface ParsedPlanStep {
  key: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  result?: AgentPlanStepResult;
}

function parsePlanInput(input: Record<string, unknown>): {
  title: string;
  explanation?: string;
  steps: ParsedPlanStep[];
} {
  const title = stringArgument(input, 'title').trim();
  if (!title) throw new Error('update_plan requires a non-empty title.');
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error('update_plan requires at least one step.');
  }
  const steps = normalizePlanProgress(input.steps.map((value, index) => parseStep(value, index)));
  const keys = new Set(steps.map(step => step.key));
  if (keys.size !== steps.length) throw new Error('update_plan step keys must be unique.');
  const allTerminal = steps.every(step => (
    step.status === 'completed' || step.status === 'failed' || step.status === 'skipped'
  ));
  const inProgress = steps.filter(step => step.status === 'in_progress').length;
  if ((!allTerminal && inProgress !== 1) || (allTerminal && inProgress !== 0)) {
    throw new Error('update_plan requires exactly one in_progress step until all steps are terminal.');
  }
  const explanation = stringArgument(input, 'explanation').trim();
  return {
    title,
    ...(explanation ? { explanation } : {}),
    steps,
  };
}

function normalizePlanProgress(steps: ParsedPlanStep[]): ParsedPlanStep[] {
  const allTerminal = steps.every(step => (
    step.status === 'completed' || step.status === 'failed' || step.status === 'skipped'
  ));
  const inProgress = steps.filter(step => step.status === 'in_progress');
  if (!allTerminal && inProgress.length === 0) {
    const next = steps.find(step => step.status === 'pending');
    if (!next) {
      throw new Error('update_plan requires one pending step that can become in_progress.');
    }
    return steps.map(step => step === next ? { ...step, status: 'in_progress' } : step);
  }
  return steps;
}

function parseStep(value: unknown, index: number): ParsedPlanStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`update_plan step ${index + 1} must be an object.`);
  }
  const step = value as Record<string, unknown>;
  const key = stringArgument(step, 'key').trim();
  const title = stringArgument(step, 'title').trim();
  const status = step.status;
  if (!key || !title || !isPlanStepStatus(status)) {
    throw new Error(`update_plan step ${index + 1} has invalid key, title, or status.`);
  }
  const description = stringArgument(step, 'description').trim();
  return {
    key,
    title,
    ...(description ? { description } : {}),
    status,
    ...(step.result === undefined ? {} : { result: parseResult(step.result, index) }),
  };
}

function parseResult(value: unknown, index: number): AgentPlanStepResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`update_plan step ${index + 1} result must be an object.`);
  }
  const result = value as Record<string, unknown>;
  return {
    ...(typeof result.summary === 'string' ? { summary: result.summary } : {}),
  };
}

function isPlanStepStatus(value: unknown): value is ParsedPlanStep['status'] {
  return ['pending', 'in_progress', 'completed', 'failed', 'skipped'].includes(String(value));
}

async function safePublish(
  publisher: RuntimeEventPublisher,
  event: Parameters<RuntimeEventPublisher['publish']>[0]
): Promise<void> {
  try {
    await publisher.publish(event);
  } catch {
    // The durable SessionView remains authoritative.
  }
}
