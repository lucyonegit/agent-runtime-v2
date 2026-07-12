import type { AgentJob, AgentPlanStep, AgentStepRun } from '../../domain/index.js';
import { StepContextLoader } from '../../runtime/loaders/step-context-loader.js';
import { ReactExecutor } from '../../runtime/executors/react-executor.js';

export class StepWorkflow {
  constructor(
    private readonly react: ReactExecutor,
    private readonly contexts: StepContextLoader
  ) {}

  execute(input: {
    job: AgentJob;
    originalGoal: string;
    step: AgentPlanStep;
    stepRun: AgentStepRun;
  }) {
    return this.react.runStep({
      job: input.job,
      stepRun: input.stepRun,
      loadContext: () => this.contexts.load(input),
    });
  }
}

