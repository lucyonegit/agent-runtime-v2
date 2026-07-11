import { describe, expect, it, vi } from 'vitest';
import type { AgentPlan, AgentPlanStep } from '../src/domain/index.js';
import { PlanSummarizer } from '../src/planner/plan-summarizer.js';
import {
  STEP_OUTPUT_INSTRUCTION,
  STEP_OUTPUT_REPAIR_INSTRUCTION,
} from '../src/planner/planner-prompts.js';
import {
  parseStepOutput,
  StepOutputValidationError,
  type StepOutputV1,
} from '../src/planner/step-output.js';

const validOutput: StepOutputV1 = {
  schemaVersion: 1,
  summary: 'completed',
  artifacts: [{ type: 'file', ref: 'result.txt' }],
  evidence: [{ claim: 'done', sourceMessageIds: [] }],
  unresolved: [],
};

describe('StepOutputV1', () => {
  it('parses JSON fences but enforces every stable field', () => {
    expect(parseStepOutput(`\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``)).toEqual(validOutput);
    expect(() => parseStepOutput({ schemaVersion: 1, summary: '', artifacts: [] }))
      .toThrow(StepOutputValidationError);
    expect(() => parseStepOutput({
      ...validOutput,
      artifacts: [{ type: 'unknown', ref: '' }],
      unresolved: [{ description: '', impact: 'urgent' }],
    })).toThrow(/artifacts\[0\].type|unresolved\[0\].impact/);
  });

  it('publishes the complete nested schema to execution and repair models', () => {
    for (const instruction of [STEP_OUTPUT_INSTRUCTION, STEP_OUTPUT_REPAIR_INSTRUCTION]) {
      expect(instruction).toContain('"type":"file|url|record|text"');
      expect(instruction).toContain('"sourceMessageIds":["message-id"]');
      expect(instruction).toContain('"impact":"low|medium|high"');
      expect(instruction).toContain('recommendedAction');
    }
  });
});

describe('PlanSummarizer', () => {
  it('receives only ordered Plan definitions and validated StepOutputs', async () => {
    const summarize = vi.fn(async () => 'final summary');
    const summarizer = new PlanSummarizer({ summarize });
    const plan: AgentPlan = {
      id: 'plan_1', sessionId: 'session_1', jobId: 'job_1', title: 'Plan', goal: 'Goal',
      status: 'completed', version: 1, createdAtMs: 1, updatedAtMs: 2, completedAtMs: 2,
    };
    const steps: AgentPlanStep[] = [step('step_2', 1), step('step_1', 0)];

    await expect(summarizer.summarize({
      originalGoal: 'Goal',
      plan,
      steps,
      outputs: [
        { stepId: 'step_1', output: validOutput },
        { stepId: 'step_2', output: { ...validOutput, summary: 'second' } },
      ],
      currentDate: '2026-07-11',
      timezone: 'Asia/Shanghai',
    })).resolves.toBe('final summary');
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({
      steps: [
        expect.objectContaining({ id: 'step_1', position: 0 }),
        expect.objectContaining({ id: 'step_2', position: 1 }),
      ],
      outputs: expect.any(Array),
    }));
  });

  it('refuses finalization when any PlanStep lacks a validated output', async () => {
    const summarizer = new PlanSummarizer({ summarize: async () => 'unused' });
    await expect(summarizer.summarize({
      originalGoal: 'Goal',
      plan: {
        id: 'plan_1', sessionId: 'session_1', jobId: 'job_1', title: 'Plan', goal: 'Goal',
        status: 'completed', version: 1, createdAtMs: 1, updatedAtMs: 2,
      },
      steps: [step('step_1', 0)],
      outputs: [],
      currentDate: '2026-07-11',
      timezone: 'Asia/Shanghai',
    })).rejects.toThrow(/one validated StepOutput/);
  });
});

function step(id: string, position: number): AgentPlanStep {
  return {
    id,
    planId: 'plan_1',
    position,
    title: id,
    instruction: id,
    status: 'completed',
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}
