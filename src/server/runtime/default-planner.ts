import { HumanMessage, SystemMessage, type AIMessageChunk } from '@langchain/core/messages';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { Runnable } from '@langchain/core/runnables';
import { PlanEngine, type PlanEnginePort, type PlanSpec } from '../../planner/plan-engine.js';
import {
  PlanSummarizer,
  type PlanSummarizerPort,
  type PlanSummaryInput,
} from '../../planner/plan-summarizer.js';
import type { PlanEngineFactory } from '../../orchestration/execution/job-execution-orchestrator.js';
import type { RuntimeEventPublisher } from '../../runtime/runtime-event-writer.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { WORKSPACE_TOOL_ROUTING_INSTRUCTION } from './runtime-context-config.js';

type ChatRunnable = Runnable<BaseLanguageModelInput, AIMessageChunk>;

export interface DefaultPlanEngineFactoryOptions {
  store: AgentStore;
  workerId: string;
  publisher: RuntimeEventPublisher;
}

export function createDefaultPlanEngineFactory(
  options: DefaultPlanEngineFactoryOptions
): PlanEngineFactory {
  return {
    create: ({ routeModel, createModel, finalizeModel }) => new PlanEngine({
      store: options.store,
      workerId: options.workerId,
      planner: new DefaultPlanner(routeModel, createModel),
      summarizer: new PlanSummarizer(new DefaultPlanSummarizer(finalizeModel)),
      publisher: options.publisher,
    }),
  };
}

const ROUTE_SYSTEM_PROMPT = `Return JSON only: {"strategy":"direct"|"planned"}.
Choose based on execution complexity, not the number of final deliverables.
Use direct only when the goal can be completed responsibly in one reasoning pass, with at most one
tool call and no intermediate result that must be checked before producing the answer.
Use planned whenever the goal needs two or more dependent stages, including research followed by
verification or synthesis, collecting information before writing a report or article, comparing
multiple sources, producing multiple deliverables, or building a non-trivial application, website,
system, or code project. A task with one final report is still planned when research and validation
must happen first. Explicit sequences such as "first ... then ..." are planned.
Examples: "hello" and "what time is it" are direct. "Research an incident and write an analysis
report" and "build a todo application" are planned.`;

export class DefaultPlanner implements PlanEnginePort {
  constructor(
    private readonly routeModel: ChatRunnable,
    private readonly createModel: ChatRunnable
  ) {}

  async route(input: { goal: string }): Promise<'direct' | 'planned'> {
    const response = await this.routeModel.invoke([
      new SystemMessage(ROUTE_SYSTEM_PROMPT),
      new HumanMessage(input.goal),
    ]);
    const modelStrategy = parseRouteStrategy(response.text);
    return modelStrategy === 'planned' || requiresPlannedExecution(input.goal)
      ? 'planned'
      : 'direct';
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
${WORKSPACE_TOOL_ROUTING_INSTRUCTION}
Return JSON only: {"title":string,"steps":[{"title":string,"instruction":string}]}.
Create an ordered execution plan that preserves every requested deliverable, output format, source
requirement, scope, and time range. Never remove or contradict an explicit user requirement.
Every step must be necessary for the goal. Collecting context or user input is preparation, not completion.
When a step requests user input, add a later step that uses the answer to produce the requested result.
The final step must perform and deliver the requested outcome; it must never merely announce future work.
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

function parseRouteStrategy(content: string): 'direct' | 'planned' {
  const normalized = content.trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '');
  try {
    const parsed = JSON.parse(normalized) as { strategy?: unknown };
    if (parsed.strategy === 'direct' || parsed.strategy === 'planned') return parsed.strategy;
  } catch {
    // The stable error below owns malformed and invalid decisions.
  }
  throw new Error(`Invalid planner route response: ${JSON.stringify(content)}`);
}

function requiresPlannedExecution(goal: string): boolean {
  const research = /调查|调研|研究|检索|搜索|搜集|核查|investigat|research|survey|search|collect/iu;
  const deliverable = /报告|文章|综述|总结|方案|report|article|analysis|brief|summary/iu;
  const staged = /先.{1,80}(?:再|然后|之后|接着|最后)|\b(?:and then|after that|followed by)\b/iu;
  const build = /(?:开发|构建|搭建|实现|创建|写|制作).{0,30}(?:应用|网站|系统|项目|程序|app|application|website|system|project)|(?:build|create|implement|develop).{0,40}(?:app|application|website|system|project)/iu;
  return (research.test(goal) && deliverable.test(goal))
    || staged.test(goal)
    || build.test(goal);
}

export class DefaultPlanSummarizer implements PlanSummarizerPort {
  constructor(private readonly model: ChatRunnable) {}

  async summarize(input: PlanSummaryInput): Promise<string> {
    const payload = JSON.stringify(input);
    const response = await this.model.invoke([
      new SystemMessage(PLAN_FINAL_SYSTEM_PROMPT),
      new HumanMessage(payload),
    ]);
    const draft = response.text.trim();
    if (!promisesDeferredWork(draft)) return draft;
    const repaired = await this.model.invoke([
      new SystemMessage(
        `${PLAN_FINAL_SYSTEM_PROMPT} The previous draft was invalid because it promises work after completion. Rewrite it as a terminal answer that delivers the result now. If the supplied outputs truly cannot satisfy the goal, state the unresolved blocker plainly; do not promise to continue.`
      ),
      new HumanMessage(JSON.stringify({ input, invalidDraft: draft })),
    ]);
    return repaired.text.trim();
  }
}

const PLAN_FINAL_SYSTEM_PROMPT =
  'Write the final user-facing answer using only the goal, ordered Plan definitions, and validated StepOutput objects supplied below. This response ends the Job immediately, so directly deliver the requested outcome now. Never promise future work, ask the user to wait, or describe work as still in progress.';

const DEFERRED_WORK_PATTERNS = [
  /(?:接下来|下一步)[，,\s]*(?:我|我们)?(?:将|会|要)/u,
  /(?:请|敬请)(?:稍候|等待)/u,
  /(?:正在|马上|即将)(?:为你|开始|进行|生成|处理|展开)/u,
  /\b(?:next|then),?\s+(?:I|we)(?:'ll| will)\b/iu,
  /\bplease wait\b/iu,
  /\bcoming (?:up|next)\b/iu,
];

function promisesDeferredWork(content: string): boolean {
  return DEFERRED_WORK_PATTERNS.some(pattern => pattern.test(content));
}
