import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentLoopModelPort } from '../../agent-loop/model-port.js';
import type { PlanEnginePort, PlanSpec } from '../../planner/plan-engine.js';
import type { PlanSummarizerPort, PlanSummaryInput } from '../../planner/plan-summarizer.js';

export class DefaultPlanner implements PlanEnginePort {
  constructor(
    private readonly routeModel: AgentLoopModelPort,
    private readonly createModel: AgentLoopModelPort
  ) {}

  async route(input: { goal: string }): Promise<'direct' | 'planned'> {
    const response = await this.routeModel.invoke({
      messages: [
        new SystemMessage('Return JSON only: {"strategy":"direct"|"planned"}. Use planned for multi-step goals.'),
        new HumanMessage(input.goal),
      ],
      tools: [],
    });
    try {
      const parsed = JSON.parse(text(response.content)) as { strategy?: unknown };
      return parsed.strategy === 'planned' ? 'planned' : 'direct';
    } catch {
      return 'direct';
    }
  }

  async createPlan(input: { goal: string }): Promise<PlanSpec> {
    const response = await this.createModel.invoke({
      messages: [
        new SystemMessage(
          'Return JSON only: {"title":string,"goal":string,"steps":[{"title":string,"instruction":string}]}. Keep steps declarative and ordered.'
        ),
        new HumanMessage(input.goal),
      ],
      tools: [],
    });
    const parsed = JSON.parse(text(response.content)) as PlanSpec;
    return parsed;
  }
}

export class DefaultPlanSummarizer implements PlanSummarizerPort {
  constructor(private readonly model: AgentLoopModelPort) {}

  async summarize(input: PlanSummaryInput): Promise<string> {
    const response = await this.model.invoke({
      messages: [
        new SystemMessage(
          'Write the final user-facing answer using only the goal, ordered Plan definitions, and validated StepOutput objects supplied below.'
        ),
        new HumanMessage(JSON.stringify(input)),
      ],
      tools: [],
    });
    return text(response.content);
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
