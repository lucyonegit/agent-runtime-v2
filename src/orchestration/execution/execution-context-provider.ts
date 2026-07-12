import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type {
  AgentJob,
  AgentPlanStep,
  AgentStepRun,
} from '../../domain/index.js';
import {
  ContextBuildService,
  type ContextMaterialSource,
} from '../../runtime/context/context-build.service.js';
import type { BuiltContext } from '../../runtime/context/context-compiler.js';
import { ContextCompressionService } from '../../runtime/context/context-compression.service.js';
import type { ContextMaterial } from '../../runtime/context/context-material.js';
import { SessionCompressionService } from '../../runtime/context/session-compression.service.js';
import type { DirectJobContextLoader } from '../../runtime/loaders/direct-job-context-loader.js';
import type { StepContextLoader } from '../../runtime/loaders/step-context-loader.js';
import type { AgentStore } from '../../storage/agent-store.js';

export interface ExecutionContextProviderPort {
  buildPlanningContext(job: AgentJob, originalGoal: string): Promise<BuiltContext>;
  buildDirectContext(job: AgentJob, originalGoal: string): Promise<BuiltContext>;
  buildStepContext(input: {
    job: AgentJob;
    originalGoal: string;
    step: AgentPlanStep;
    stepRun: AgentStepRun;
  }): Promise<BuiltContext>;
}

export interface ContextCompressionModel {
  invoke(input: BaseLanguageModelInput): Promise<{ text: string }>;
}

export interface ContextCompressionModelFactory {
  create(input: {
    job: AgentJob;
    context: BuiltContext;
    logicalCallKey: string;
    stepRunId?: string;
  }): ContextCompressionModel;
}

interface SessionCompressionPort {
  compress(input: Parameters<SessionCompressionService['compress']>[0]): Promise<void>;
}

interface StepCompressionPort {
  compress(input: Parameters<ContextCompressionService['compress']>[0]): Promise<void>;
}

export interface ExecutionContextProviderOptions {
  store: AgentStore;
  modelName: string;
  directContext: Pick<DirectJobContextLoader, 'load'>;
  stepContext: Pick<StepContextLoader, 'load'>;
  compressionModels: ContextCompressionModelFactory;
  contextBuildService?: ContextBuildService;
  sessionCompression?: SessionCompressionPort;
  stepCompression?: StepCompressionPort;
}

export class ExecutionContextProvider implements ExecutionContextProviderPort {
  readonly #contexts: ContextBuildService;
  readonly #sessionCompression: SessionCompressionPort;
  readonly #stepCompression: StepCompressionPort;

  constructor(private readonly options: ExecutionContextProviderOptions) {
    this.#contexts = options.contextBuildService ?? new ContextBuildService();
    this.#sessionCompression = options.sessionCompression ?? new SessionCompressionService({
      store: options.store,
      modelName: options.modelName,
    });
    this.#stepCompression = options.stepCompression ?? new ContextCompressionService({
      store: options.store,
      modelName: options.modelName,
    });
  }

  buildPlanningContext(job: AgentJob, originalGoal: string): Promise<BuiltContext> {
    return this.#buildJobContext(job, originalGoal);
  }

  buildDirectContext(job: AgentJob, originalGoal: string): Promise<BuiltContext> {
    return this.#buildJobContext(job, originalGoal);
  }

  buildStepContext(input: {
    job: AgentJob;
    originalGoal: string;
    step: AgentPlanStep;
    stepRun: AgentStepRun;
  }): Promise<BuiltContext> {
    return this.#build({
      job: input.job,
      stepRunId: input.stepRun.id,
      purpose: 'step_execution',
      load: () => this.options.stepContext.load(input),
    });
  }

  #buildJobContext(job: AgentJob, originalGoal: string): Promise<BuiltContext> {
    return this.#build({
      job,
      purpose: 'job_execution',
      load: () => this.options.directContext.load(job, originalGoal),
    });
  }

  #build(input: {
    job: AgentJob;
    stepRunId?: string;
    purpose: 'job_execution' | 'step_execution';
    load(): Promise<ContextMaterial>;
  }): Promise<BuiltContext> {
    const source: ContextMaterialSource = {
      load: input.load,
      compress: async (material, built) => {
        const invoke = async (
          messages: BaseLanguageModelInput,
          compressionContext: BuiltContext,
          logicalCallKey: string
        ): Promise<string> => {
          const model = this.options.compressionModels.create({
            job: input.job,
            context: compressionContext,
            logicalCallKey,
            ...(input.stepRunId ? { stepRunId: input.stepRunId } : {}),
          });
          return (await model.invoke(messages)).text;
        };
        if (input.purpose === 'job_execution' && material.bundles) {
          return this.#sessionCompression.compress({
            job: input.job,
            material,
            built,
            invoke,
          });
        }
        return this.#stepCompression.compress({
          job: input.job,
          ...(input.stepRunId ? { stepRunId: input.stepRunId } : {}),
          purpose: input.purpose,
          material,
          built,
          invoke,
        });
      },
    };
    return this.#contexts.build(source);
  }
}
