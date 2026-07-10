import { randomUUID } from 'node:crypto';
import type { AgentJob, AgentPlan, AgentPlanStep, AgentStepRun } from '../domain/index.js';
import type { AgentStore } from '../storage/agent-store.js';
import { parseStepOutput, type StepOutputV1 } from './step-output.js';
import { PlanSummarizer } from './plan-summarizer.js';

export interface PlanSpec {
  title: string;
  goal: string;
  steps: Array<{ title: string; instruction: string }>;
}

export interface PlanEnginePort {
  route(input: { goal: string }): Promise<'direct' | 'planned'>;
  createPlan(input: { goal: string }): Promise<PlanSpec>;
}

export interface PlanEngineIds {
  planId(): string;
  stepId(): string;
  stepRunId(): string;
  messageId(): string;
  outputId(): string;
}

export interface PlanEngineOptions {
  store: AgentStore;
  workerId: string;
  planner: PlanEnginePort;
  summarizer: PlanSummarizer;
  ids?: PlanEngineIds;
  clock?: { nowMs(): number };
  maxStepRunsPerStep?: number;
}

export class PlanEngine {
  readonly #store: AgentStore;
  readonly #workerId: string;
  readonly #planner: PlanEnginePort;
  readonly #summarizer: PlanSummarizer;
  readonly #ids: PlanEngineIds;
  readonly #clock: { nowMs(): number };
  readonly #maxStepRunsPerStep: number;

  constructor(options: PlanEngineOptions) {
    this.#store = options.store;
    this.#workerId = options.workerId;
    this.#planner = options.planner;
    this.#summarizer = options.summarizer;
    this.#ids = options.ids ?? randomPlanIds;
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#maxStepRunsPerStep = options.maxStepRunsPerStep ?? 2;
  }

  async route(job: AgentJob, originalGoal: string) {
    const strategy = await this.#planner.route({ goal: originalGoal });
    const routedJob = await this.#store.routeJob({
      jobId: job.id,
      workerId: this.#workerId,
      attemptId: requireAttempt(job),
      strategy,
      nowMs: this.#clock.nowMs(),
    });
    if (strategy === 'direct') return { strategy, job: routedJob } as const;
    const spec = await this.#planner.createPlan({ goal: originalGoal });
    validatePlanSpec(spec);
    const created = await this.#store.createPlan({
      sessionId: job.sessionId,
      jobId: job.id,
      workerId: this.#workerId,
      attemptId: requireAttempt(job),
      planId: this.#ids.planId(),
      messageId: this.#ids.messageId(),
      title: spec.title,
      goal: spec.goal,
      steps: spec.steps.map(step => ({ ...step, id: this.#ids.stepId() })),
      nowMs: this.#clock.nowMs(),
    });
    return { strategy, ...created } as const;
  }

  async createNextStepRun(job: AgentJob): Promise<{
    job: AgentJob;
    plan: AgentPlan;
    step: AgentPlanStep;
    stepRun: AgentStepRun;
  } | undefined> {
    const plan = await this.#store.getPlanByJobId(job.id);
    if (!plan) throw new Error(`Planned Job ${job.id} has no Plan.`);
    const steps = await this.#store.listPlanSteps(plan.id);
    const step = steps.find(candidate => candidate.status === 'pending');
    if (!step) return undefined;
    return this.#store.createStepRun({
      sessionId: job.sessionId,
      jobId: job.id,
      workerId: this.#workerId,
      attemptId: requireAttempt(job),
      planId: plan.id,
      stepId: step.id,
      stepRunId: this.#ids.stepRunId(),
      executor: 'agent',
      maxRunsPerStep: this.#maxStepRunsPerStep,
      nowMs: this.#clock.nowMs(),
    });
  }

  async finalize(
    job: AgentJob,
    originalGoal: string,
    currentDate: string,
    timezone: string
  ) {
    const plan = await this.#store.getPlanByJobId(job.id);
    if (!plan || plan.status !== 'completed') {
      throw new Error(`Job ${job.id} cannot finalize before its Plan is completed.`);
    }
    const steps = await this.#store.listPlanSteps(plan.id);
    const messages = await this.#store.listSessionMessages(job.sessionId);
    const outputs: Array<{ stepId: string; output: StepOutputV1 }> = steps.map(step => {
      const message = messages.find(candidate => candidate.id === step.outputMessageId);
      const structured = message?.metadata?.structuredOutput;
      if (!message || structured === undefined) {
        throw new Error(`PlanStep ${step.id} has no committed structured StepOutput.`);
      }
      return { stepId: step.id, output: parseStepOutput(structured) };
    });
    const content = await this.#summarizer.summarize({
      originalGoal,
      plan,
      steps,
      outputs,
      currentDate,
      timezone,
    });
    return this.#store.completeJobWithFinalMessage({
      sessionId: job.sessionId,
      jobId: job.id,
      workerId: this.#workerId,
      attemptId: requireAttempt(job),
      outputId: this.#ids.outputId(),
      messageId: this.#ids.messageId(),
      content,
      messageType: 'plan_final',
      nowMs: this.#clock.nowMs(),
    });
  }
}

function validatePlanSpec(spec: PlanSpec): void {
  if (!spec.title.trim() || !spec.goal.trim()) throw new Error('Plan title and goal must be non-empty.');
  if (spec.steps.length === 0) throw new Error('Plan must contain at least one step.');
  for (const step of spec.steps) {
    if (!step.title.trim() || !step.instruction.trim()) {
      throw new Error('Every PlanStep requires a title and instruction.');
    }
  }
}

function requireAttempt(job: AgentJob): string {
  if (!job.currentAttemptId) throw new Error(`Job ${job.id} has no active attempt.`);
  return job.currentAttemptId;
}

const randomPlanIds: PlanEngineIds = {
  planId: () => `plan_${randomUUID()}`,
  stepId: () => `step_${randomUUID()}`,
  stepRunId: () => `step_run_${randomUUID()}`,
  messageId: () => `message_${randomUUID()}`,
  outputId: () => `output_${randomUUID()}`,
};
