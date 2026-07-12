import type { AgentJob } from '../../domain/index.js';
import type { PlanEngine } from '../../planner/plan-engine.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { PlanFinalizer } from './plan-finalizer.js';
import { StepWorkflow } from './step-workflow.js';

export interface PlannedJobWorkflowOptions {
  store: Pick<AgentStore,
    | 'listJobStepRuns'
    | 'getPlanByJobId'
    | 'listPlanSteps'
  >;
  stepExecutor: StepWorkflow;
  finalizer?: PlanFinalizer;
  requireOwnedJob(jobId: string): Promise<AgentJob>;
}

export class PlannedJobWorkflow {
  readonly #finalizer: PlanFinalizer;

  constructor(private readonly options: PlannedJobWorkflowOptions) {
    this.#finalizer = options.finalizer ?? new PlanFinalizer();
  }

  async execute(job: AgentJob, originalGoal: string, engine: PlanEngine): Promise<void> {
    while (true) {
      const current = await this.options.requireOwnedJob(job.id);
      if (current.status === 'waiting_user_input' || isTerminal(current)) return;
      if (current.stage === 'finalizing') {
        await this.#finalizer.finalize(engine, current, originalGoal);
        return;
      }
      const runs = await this.options.store.listJobStepRuns(current.id);
      let activeRun = runs.find(run => ['running', 'resuming'].includes(run.status));
      let currentJob = current;
      if (!activeRun) {
        const created = await engine.createNextStepRun(current);
        if (!created) throw new Error('Planned Job has no pending step and is not finalizing.');
        activeRun = created.stepRun;
        currentJob = created.job;
      }
      const plan = await this.options.store.getPlanByJobId(current.id);
      const steps = plan ? await this.options.store.listPlanSteps(plan.id) : [];
      const step = steps.find(candidate => candidate.id === activeRun!.stepId);
      if (!step) throw new Error(`StepRun ${activeRun.id} has no PlanStep.`);
      const result = await this.options.stepExecutor.execute({
        job: currentJob,
        originalGoal,
        step,
        stepRun: activeRun,
      });
      if (result.type === 'waiting_user_input') return;
      if (result.type === 'failed' && !result.retryStep) return;
      job = result.job;
    }
  }
}

function isTerminal(job: AgentJob): boolean {
  return ['completed', 'failed', 'cancelled'].includes(job.status);
}

