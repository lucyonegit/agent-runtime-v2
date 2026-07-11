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

  async createPlan(input: {
    goal: string;
    currentDate: string;
    timezone: string;
    availableTools: string[];
  }): Promise<PlanSpec> {
    const response = await this.createModel.invoke([
      new SystemMessage(
        `Current date: ${input.currentDate}. Timezone: ${input.timezone}.
Available runtime tools: ${input.availableTools.join(', ') || 'none'}.
Return JSON only: {"title":string,"steps":[{"title":string,"instruction":string}]}.
Create an ordered execution plan that preserves every requested deliverable, output format, source
requirement, scope, and time range. Never remove or contradict an explicit user requirement.
Do not add unrequested deliverables or constraints such as JSON output, bilingual output, files,
artifacts, word limits, or extra formatting. Do not create or write files unless the user requested it.
Do not invent facts, sources, dates, URLs, evidence, or conclusions. Research plans must discover
and verify sources before extracting facts, and must extract facts before writing conclusions.
Each step instruction may contain only actions and acceptance criteria. It must not contain possible
news events, factual claims, expected findings, or examples of conclusions. Do not mention a concrete
event or finding unless it appeared in the user's request. Search accessible sources first, then select
specific sources based on observed recency, relevance, accessibility, and credibility.
Do not prescribe APIs, integrations, or tools that are absent from the available runtime tools.
Use the current date as the upper bound for relative periods such as recent/latest unless the user
specified another bound. Steps describe work to perform, never results that have not been observed.`
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
