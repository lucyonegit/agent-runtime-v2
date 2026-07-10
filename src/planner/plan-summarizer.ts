import type { AgentPlan, AgentPlanStep } from '../domain/index.js';
import type { StepOutputV1 } from './step-output.js';

export interface PlanSummaryInput {
  originalGoal: string;
  plan: AgentPlan;
  steps: AgentPlanStep[];
  outputs: Array<{ stepId: string; output: StepOutputV1 }>;
  currentDate: string;
  timezone: string;
}

export interface PlanSummarizerPort {
  summarize(input: PlanSummaryInput): Promise<string>;
}

export class PlanSummarizer {
  constructor(private readonly port: PlanSummarizerPort) {}

  async summarize(input: PlanSummaryInput): Promise<string> {
    const orderedSteps = [...input.steps].sort((left, right) => left.position - right.position);
    if (input.outputs.length !== orderedSteps.length) {
      throw new Error('Plan finalization requires one validated StepOutput per PlanStep.');
    }
    const outputIds = new Set(input.outputs.map(output => output.stepId));
    if (orderedSteps.some(step => !outputIds.has(step.id))) {
      throw new Error('Plan finalization is missing a StepOutput for at least one PlanStep.');
    }
    const result = await this.port.summarize({ ...input, steps: orderedSteps });
    if (!result.trim()) throw new Error('Plan summarizer returned empty output.');
    return result;
  }
}
