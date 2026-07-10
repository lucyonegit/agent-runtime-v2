import { ChatOpenAI } from '@langchain/openai';
import type { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import type {
  AgentLoopModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
  ProviderTokenUsage,
} from '../../agent-loop/model-port.js';

export interface OpenAIModelPortOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
}

export class OpenAIModelPort implements AgentLoopModelPort {
  readonly #model: ChatOpenAI;

  constructor(options: OpenAIModelPortOptions) {
    this.#model = new ChatOpenAI({
      apiKey: options.apiKey,
      model: options.model,
      temperature: 0,
      ...(options.baseURL ? { configuration: { baseURL: options.baseURL } } : {}),
    });
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const runnable = this.#bind(request);
    const response = await runnable.invoke(request.messages, { signal: request.signal }) as AIMessage;
    return {
      content: response.content,
      toolCalls: response.tool_calls?.map(call => ({ id: call.id, name: call.name, args: call.args })),
      usage: normalizeUsage(response.usage_metadata),
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    const runnable = this.#bind(request);
    const stream = await runnable.stream(request.messages, { signal: request.signal });
    for await (const value of stream) {
      const chunk = value as AIMessageChunk;
      yield {
        content: chunk.content,
        toolCallChunks: chunk.tool_call_chunks?.map(call => ({
          index: call.index,
          id: call.id,
          name: call.name,
          args: call.args,
        })),
        usage: normalizeUsage(chunk.usage_metadata),
      };
    }
  }

  #bind(request: ModelRequest) {
    if (request.tools.length === 0) return this.#model;
    return this.#model.bindTools(request.tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
      },
    })));
  }
}

function normalizeUsage(value: AIMessage['usage_metadata']): ProviderTokenUsage | undefined {
  if (!value) return undefined;
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    totalTokens: value.total_tokens,
    source: 'provider',
  };
}
