import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { AgentJob } from '../../domain/index.js';
import {
  ContextBuildService,
  type ContextMaterialSource,
} from '../../runtime/context/context-build.service.js';
import type { BuiltContext } from '../../runtime/context/context-compiler.js';
import type { ContextMaterial } from '../../runtime/context/context-material.js';
import { ContextCompressionService } from '../../runtime/context/context-compression.service.js';
import type { ExecutionContextLoader } from '../../runtime/loaders/execution-context-loader.js';
import type { AgentStore } from '../../storage/agent-store.js';

interface ContextCompressionModel {
  invoke(input: BaseLanguageModelInput): Promise<{ text: string }>;
}

interface ContextCompressionModelFactory {
  create(input: {
    job: AgentJob;
    context: BuiltContext;
    logicalCallKey: string;
  }): ContextCompressionModel;
}

interface ContextCompressionPort {
  compress(input: Parameters<ContextCompressionService['compress']>[0]): Promise<boolean>;
}

export interface ExecutionContextProviderOptions {
  store: AgentStore;
  modelName: string;
  executionContext: Pick<ExecutionContextLoader, 'load'>;
  compressionModels: ContextCompressionModelFactory;
  contextBuildService?: ContextBuildService;
  contextCompression?: ContextCompressionPort;
}

/**
 * One public context operation exists for live execution: build the next Job
 * turn. The provider owns unified Context Memory compression but knows nothing about
 * plans, tools or executor stages.
 */
export class ExecutionContextProvider {
  readonly #contexts: ContextBuildService;
  readonly #contextCompression: ContextCompressionPort;

  constructor(private readonly options: ExecutionContextProviderOptions) {
    this.#contexts = options.contextBuildService ?? new ContextBuildService();
    this.#contextCompression = options.contextCompression ?? new ContextCompressionService({
      store: options.store,
      modelName: options.modelName,
    });
  }

  buildJobContext(job: AgentJob, originalGoal: string): Promise<BuiltContext> {
    const source: ContextMaterialSource = {
      load: () => this.options.executionContext.load(job, originalGoal),
      compress: async (material: ContextMaterial, built?: BuiltContext) => {
        return this.#contextCompression.compress({
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
