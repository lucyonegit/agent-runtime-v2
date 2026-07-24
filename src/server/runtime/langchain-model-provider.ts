import { ChatOpenAI } from '@langchain/openai';
import {
  SimpleChatModel,
  type BaseChatModel,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ModelConfig } from '../../config/model-config.js';

export function createLangChainChatModel(
  config: ModelConfig,
  maxOutputTokens?: number
): BaseChatModel {
  if (!config.apiKey) return new MissingCredentialsChatModel(config.provider);
  return new ChatOpenAI({
    apiKey: config.apiKey,
    model: config.modelName,
    temperature: config.temperature,
    streaming: config.streaming,
    timeout: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    ...(maxOutputTokens ? { maxTokens: maxOutputTokens } : {}),
    ...(config.baseURL ? { configuration: { baseURL: config.baseURL } } : {}),
  });
}

class MissingCredentialsChatModel extends SimpleChatModel<BaseChatModelCallOptions> {
  constructor(private readonly providerName: string) { super({}); }

  _llmType(): string { return 'missing_credentials'; }

  bindTools(_tools: StructuredToolInterface[]): this { return this; }

  async _call(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<string> {
    throw new Error(
      this.providerName === 'dashscope'
        ? 'DASHSCOPE_API_KEY is required to execute Agent Jobs.'
        : 'DASHSCOPE_API_KEY or OPENAI_API_KEY is required to execute Agent Jobs.'
    );
  }
}
