import type { AgentJob, AgentPlanStep, AgentStepRun } from '../../domain/index.js';
import type { ExecutionContextProviderPort } from '../execution/execution-context-provider.js';
import { ReactExecutionRuntime } from '../../runtime/react-execution-runtime.js';

export class StepWorkflow {
  constructor(
    private readonly react: ReactExecutionRuntime,
    private readonly contexts: ExecutionContextProviderPort
  ) {}

  async execute(input: {
    job: AgentJob;
    originalGoal: string;
    step: AgentPlanStep;
    stepRun: AgentStepRun;
  }) {
    const context = await this.contexts.buildStepContext(input);
    return this.react.runStep({
      job: input.job,
      stepRun: input.stepRun,
      context,
    });
  }
}
