import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type {
  AgentContextInputManifest,
  AgentTask,
  AgentTaskRun,
  AgentModelCallType,
} from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import {
  AuditedChatModel,
  type AuditedChatModelOptions,
} from './audited-chat-model.js';

export interface AuditedModelFactoryOptions {
  delegate: BaseChatModel;
  store: AgentStore;
  workerId: string;
  provider: string;
  modelName: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  publisher?: AuditedChatModelOptions['publisher'];
}

/**
 * Runtime 共享的审计模型工厂。
 *
 * ReAct 与 Context 压缩只声明本次调用的类型、输入清单和工具集合；
 * Provider 绑定、TaskRun 定位和 ModelCall 审计参数统一在这里组装。
 */
export class AuditedModelFactory {
  constructor(private readonly options: AuditedModelFactoryOptions) {}

  create(input: {
    task: AgentTask;
    taskRun: AgentTaskRun;
    manifest: AgentContextInputManifest | (() => AgentContextInputManifest);
    callType: AgentModelCallType;
    logicalCallKey: string;
    tools?: StructuredToolInterface[];
  }): AuditedChatModel {
    return new AuditedChatModel({
      delegate: this.#bindTools(input.tools ?? []),
      store: this.options.store,
      workerId: this.options.workerId,
      target: {
        sessionId: input.task.sessionId,
        taskId: input.task.id,
        taskRunId: input.taskRun.id,
        runNo: input.taskRun.runNo,
      },
      callType: input.callType,
      logicalCallKey: input.logicalCallKey,
      provider: this.options.provider,
      model: this.options.modelName,
      maxContextTokens: this.options.maxContextTokens,
      reservedOutputTokens: this.options.reservedOutputTokens,
      baseManifest: input.manifest,
      publisher: this.options.publisher,
    });
  }

  #bindTools(tools: StructuredToolInterface[]): Runnable<BaseLanguageModelInput, AIMessageChunk> {
    if (tools.length === 0) return this.options.delegate;
    if (!this.options.delegate.bindTools) {
      throw new Error(`Model ${this.options.modelName} does not support LangChain bindTools().`);
    }
    return this.options.delegate.bindTools(tools) as Runnable<
      BaseLanguageModelInput,
      AIMessageChunk
    >;
  }
}
