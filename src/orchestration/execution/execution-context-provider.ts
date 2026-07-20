import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { AgentJob } from '../../domain/index.js';
import {
  ContextBuildService,
  type ContextMaterialSource,
} from '../../runtime/context/context-build.service.js';
import type { BuiltContext } from '../../runtime/context/context-compiler.js';
import type { ContextMaterial } from '../../runtime/context/context-material.js';
import { SessionCompressionService } from '../../runtime/context/session-compression.service.js';
import type { JobContextLoader } from '../../runtime/loaders/job-context-loader.js';
import type { AgentStore } from '../../storage/agent-store.js';

export interface ExecutionContextProviderPort {
  buildJobContext(job: AgentJob, originalGoal: string): Promise<BuiltContext>;
}

export interface ContextCompressionModel {
  invoke(input: BaseLanguageModelInput): Promise<{ text: string }>;
}

export interface ContextCompressionModelFactory {
  create(input: {
    job: AgentJob;
    context: BuiltContext;
    logicalCallKey: string;
  }): ContextCompressionModel;
}

interface SessionCompressionPort {
  compress(input: Parameters<SessionCompressionService['compress']>[0]): Promise<void>;
}

export interface ExecutionContextProviderOptions {
  store: AgentStore;
  modelName: string;
  jobContext: Pick<JobContextLoader, 'load'>;
  compressionModels: ContextCompressionModelFactory;
  contextBuildService?: ContextBuildService;
  sessionCompression?: SessionCompressionPort;
}

/**
 * One public context operation exists for live execution: build the next Job
 * turn. The provider owns rolling-session compression but knows nothing about
 * plans, tools or executor stages.
 */
export class ExecutionContextProvider implements ExecutionContextProviderPort {
  readonly #contexts: ContextBuildService;
  readonly #sessionCompression: SessionCompressionPort;

  constructor(private readonly options: ExecutionContextProviderOptions) {
    this.#contexts = options.contextBuildService ?? new ContextBuildService();
    this.#sessionCompression = options.sessionCompression ?? new SessionCompressionService({
      store: options.store,
      modelName: options.modelName,
    });
  }

  buildJobContext(job: AgentJob, originalGoal: string): Promise<BuiltContext> {
    const source: ContextMaterialSource = {
      load: () => this.options.jobContext.load(job, originalGoal),
      compress: async (material: ContextMaterial, built: BuiltContext) => {
        await this.#sessionCompression.compress({
          job,
          material,
          built,
          invoke: async (messages, compressionContext, logicalCallKey) => {
            const model = this.options.compressionModels.create({
              job,
              context: compressionContext,
              logicalCallKey,
            });
            return (await model.invoke(messages)).text;
          },
        });
      },
    };
    return this.#contexts.build(source);
  }
}
