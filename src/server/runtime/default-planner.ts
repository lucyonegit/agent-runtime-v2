import { HumanMessage, SystemMessage, type AIMessageChunk } from '@langchain/core/messages';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { Runnable } from '@langchain/core/runnables';
import type { PlanEnginePort, PlanSpec } from '../../planner/plan-engine.js';
import type { PlanSummarizerPort, PlanSummaryInput } from '../../planner/plan-summarizer.js';

type ChatRunnable = Runnable<BaseLanguageModelInput, AIMessageChunk>;

export class DefaultPlanner implements PlanEnginePort {
  constructor(
    private readonly routeModel: ChatRunnable,
    private readonly createModel: ChatRunnable
  ) {}

  async route(input: { goal: string }): Promise<'direct' | 'planned'> {
    const response = await this.routeModel.invoke([
      new SystemMessage('Return JSON only: {"strategy":"direct"|"planned"}. Use planned for multi-step goals.'),
      new HumanMessage(input.goal),
    ]);
    try {
      const parsed = JSON.parse(response.text) as { strategy?: unknown };
      return parsed.strategy === 'planned' ? 'planned' : 'direct';
    } catch {
      return 'direct';
    }
  }

  async createPlan(input: { goal: string }): Promise<PlanSpec> {
    const response = await this.createModel.invoke([
      new SystemMessage(
        'Return JSON only: {"title":string,"goal":string,"steps":[{"title":string,"instruction":string}]}. Keep steps declarative and ordered.'
      ),
      new HumanMessage(input.goal),
    ]);
    return JSON.parse(response.text) as PlanSpec;
  }
}

export class DefaultPlanSummarizer implements PlanSummarizerPort {
  constructor(private readonly model: ChatRunnable) {}

  async summarize(input: PlanSummaryInput): Promise<string> {
    const response = await this.model.invoke([
      new SystemMessage(
        'Write the final user-facing answer using only the goal, ordered Plan definitions, and validated StepOutput objects supplied below.'
      ),
      new HumanMessage(JSON.stringify(input)),
    ]);
    return response.text;
  }
}
