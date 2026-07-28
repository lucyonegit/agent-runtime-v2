import type { AgentJob } from '../../domain/index.js';
import { compileContext, CONTEXT_RULES_VERSION } from './context-compiler.js';
import { ContextCompressionService } from './context-compression.service.js';
import { AuditedModelFactory } from '../model/audited-model.factory.js';
import { buildContextWithCompression } from './helpers/context-build.helper.js';
import {
  loadJobContextMaterial,
  loadNextTurnContextMaterial,
} from './helpers/context-material.helper.js';
import type {
  BuiltContext,
  ContextMaterial,
  ReActContextMaterialOptions,
} from './types/context.types.js';

export interface ReActContextServiceOptions extends ReActContextMaterialOptions {
  /**
   * 正式执行提供共享审计模型工厂；只读预览不提供，因此不会触发压缩或写入 ContextMemory。
   */
  modelFactory?: AuditedModelFactory;
}

/**
 * Durable ReAct 循环唯一的 Context 公共入口。
 *
 * 对外只暴露正式构建与只读预览；Material 加载、编译、压缩服务和压缩模型调用
 * 都在该边界内部完成，编排层不需要理解 Context 的内部治理策略。
 */
export class ReActContextService {
  readonly #compression?: ContextCompressionService;

  constructor(private readonly options: ReActContextServiceOptions) {
    if (options.modelFactory && options.store.context.replaceSummary) {
      this.#compression = new ContextCompressionService({
        store: { replaceSummary: options.store.context.replaceSummary },
        modelName: options.model.name,
        contextConfig: options.contextConfig,
      });
    }
  }

  buildForJob(job: AgentJob): Promise<BuiltContext> {
    const compression = this.#requiredCompressionRuntime();
    return buildContextWithCompression({
      // 压缩会更新数据库中的 rolling summary，所以每个 pass 都从持久化事实重新构建。
      loadMaterial: () => loadJobContextMaterial(this.options, job),
      // Context 构建循环只关心“数据是否发生变化”；具体模型调用和摘要落库由本服务绑定。
      compressMaterial: input => this.#compressJobContext(job, compression, input),
      config: this.options.contextConfig,
    });
  }

  async previewJob(
    job: AgentJob,
    contextRulesVersion = CONTEXT_RULES_VERSION
  ): Promise<BuiltContext> {
    const material = await loadJobContextMaterial(
      this.options,
      job,
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

  #requiredCompressionRuntime(): {
    service: ContextCompressionService;
    models: AuditedModelFactory;
  } {
    if (!this.#compression || !this.options.modelFactory) {
      throw new Error('Live ReAct Context requires model audit and writable ContextMemory.');
    }
    return {
      service: this.#compression,
      models: this.options.modelFactory,
    };
  }

  #compressJobContext(
    job: AgentJob,
    compression: {
      service: ContextCompressionService;
      models: AuditedModelFactory;
    },
    input: {
      material: ContextMaterial;
      context?: BuiltContext;
    }
  ): Promise<boolean> {
    return compression.service.compress({
      job,
      material: input.material,
      built: input.context,
      // 通过工厂创建带审计能力的压缩模型，避免 Context 模块直接依赖具体 Provider。
      invoke: async (messages, context, logicalCallKey) => {
        const model = compression.models.create({
          job,
          manifest: context.inputManifest,
          callType: 'context.compress',
          logicalCallKey,
        });
        return (await model.invoke(messages)).text;
      },
    });
  }
}
