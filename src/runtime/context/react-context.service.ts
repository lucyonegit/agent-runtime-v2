import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { AgentJob } from '../../domain/index.js';
import { compileContext, CONTEXT_RULES_VERSION } from './context-compiler.js';
import { ContextCompressionService } from './context-compression.service.js';
import { buildContextWithCompression } from './helpers/context-build.helper.js';
import {
  loadJobContextMaterial,
  loadNextTurnContextMaterial,
} from './helpers/context-material.helper.js';
import type {
  BuiltContext,
  ReActContextMaterialOptions,
} from './types/context.types.js';

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

export interface ReActContextServiceOptions extends ReActContextMaterialOptions {
  /**
   * Live execution supplies both ports. Read-only inspection deliberately
   * omits them, so previewing Context can never mutate Context Memory.
   */
  compression?: ContextCompressionPort;
  compressionModels?: ContextCompressionModelFactory;
}

/**
 * The single public Context boundary for the durable ReAct loop.
 *
 * Core stays intentionally small: material assembly, token calculations and
 * the compile/compress retry loop live in named helpers.
 */
export class ReActContextService {
  constructor(private readonly options: ReActContextServiceOptions) {}

  buildForJob(job: AgentJob, originalGoal: string): Promise<BuiltContext> {
    const compression = this.#requiredCompressionPorts();
    return buildContextWithCompression(
      () => loadJobContextMaterial(this.options, job, originalGoal),
      async (material, built) => compression.service.compress({
        job,
        material,
        built,
        invoke: async (messages, context, logicalCallKey) => {
          const model = compression.models.create({ job, context, logicalCallKey });
          return (await model.invoke(messages)).text;
        },
      })
    );
  }

  async previewJob(
    job: AgentJob,
    originalGoal: string,
    contextRulesVersion = CONTEXT_RULES_VERSION
  ): Promise<BuiltContext> {
    const material = await loadJobContextMaterial(
      this.options,
      job,
      originalGoal,
      contextRulesVersion
    );
    return compileContext(material);
  }

  async previewNextTurn(
    sessionId: string
  ): Promise<{ built: BuiltContext; latestJobId?: string }> {
    const preview = await loadNextTurnContextMaterial(this.options, sessionId);
    return {
      built: compileContext(preview.material),
      latestJobId: preview.latestJobId,
    };
  }

  #requiredCompressionPorts(): {
    service: ContextCompressionPort;
    models: ContextCompressionModelFactory;
  } {
    if (!this.options.compression || !this.options.compressionModels) {
      throw new Error('Live ReAct Context requires compression ports.');
    }
    return {
      service: this.options.compression,
      models: this.options.compressionModels,
    };
  }
}
