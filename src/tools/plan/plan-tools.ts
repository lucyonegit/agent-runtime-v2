import { DynamicStructuredTool } from '@langchain/core/tools';
import type { AgentPlanStep, AgentPlanStepStatus } from '../../domain/index.js';
import type { RuntimeTool } from '../../runtime/execution/tool-executor.js';
import { jsonToolOutput, runtimeContext, stringArgument } from '../helpers/tool-input.helper.js';
import type { CreatePlanToolsOptions } from './plan-tool.types.js';

export type { CreatePlanToolsOptions } from './plan-tool.types.js';

/** Session-level ActivePlan control tool. It is temporary Task context, not timeline data. */
export function createPlanTools(options: CreatePlanToolsOptions): RuntimeTool[] {
  const clock = options.clock ?? { nowMs: () => Date.now() };
  const updatePlan = new DynamicStructuredTool({
    name: 'update_plan',
    description: [
      'Create or replace the current Task plan. Call it alone for multi-step work.',
      'Include a concise user-facing progress note in the assistant content; never call this tool with empty assistant text.',
      'Send the complete plan each time. Keep exactly one step in_progress until all steps are completed.',
      'Mark a step completed only after its stated outcome is achieved; evidence-gathering steps require observed tool results.',
      'Build, test, typecheck, install, executable, and runtime verification steps require a successful command or process tool result; file inspection alone is not execution evidence.',
      'A plan guides progress but does not block an honest final answer.',
    ].join(' '),
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short user-facing plan title.' },
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              status: { enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['step', 'status'],
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
      const input = rawInput as Record<string, unknown>;
      const title = stringArgument(input, 'title').trim();
      const steps = parseSteps(input.steps);
      if (!title) throw new Error('update_plan requires a non-empty title.');
      validateProgress(steps);
      const plan = await options.store.plans.apply({
        sessionId: context.sessionId,
        taskId: context.taskId,
        taskRunId: context.taskRunId,
        ownerId: options.workerId,
        title,
        steps,
        nowMs: clock.nowMs(),
      });
      await safePublish(options, { type: 'plan.updated', sessionId: context.sessionId, plan });
      return jsonToolOutput({ title: plan.title, steps: plan.steps, version: plan.version });
    },
  });
  return [{
    tool: updatePlan,
    sideEffectLevel: 'idempotent',
    contextScope: 'task',
    exclusive: true,
  }];
}

function parseSteps(value: unknown): AgentPlanStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('update_plan requires at least one step.');
  }
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`Plan step ${index + 1} must be an object.`);
    }
    const record = candidate as Record<string, unknown>;
    const step = stringArgument(record, 'step').trim();
    const status = record.status;
    if (!step || !isStepStatus(status)) {
      throw new Error(`Plan step ${index + 1} has an invalid step or status.`);
    }
    return { step, status };
  });
}

function validateProgress(steps: AgentPlanStep[]): void {
  const active = steps.filter(step => step.status === 'in_progress').length;
  const allCompleted = steps.every(step => step.status === 'completed');
  if ((!allCompleted && active !== 1) || (allCompleted && active !== 0)) {
    throw new Error('Plan requires exactly one in_progress step until all steps are completed.');
  }
}

function isStepStatus(value: unknown): value is AgentPlanStepStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

async function safePublish(
  options: Pick<CreatePlanToolsOptions, 'publisher'>,
  event: Parameters<CreatePlanToolsOptions['publisher']['publish']>[0]
): Promise<void> {
  try { await options.publisher.publish(event); } catch { /* SessionView is authoritative. */ }
}
