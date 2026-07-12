import type { AgentJob, AgentPlanStep, AgentStepRun } from '../../domain/index.js';
import { StepContextLoader } from '../loaders/step-context-loader.js';
import { ReactExecutor } from './react-executor.js';

export class StepExecutor {
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
