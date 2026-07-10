import { ChatOpenAI } from '@langchain/openai';
import { type AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { ContextBuilder } from '../../context/index.js';
import {
  PlannerCore,
  ReactCore,
  type ReactCoreStreamChunk,
} from '../../core/index.js';
import type { AgentModelTokenUsage } from '../../domain/index.js';
import {
  createCodeRuntimeTools,
  createOpenAIToolDefinitions,
  createPlannerStepRuntimeTools,
  createRuntimeTools,
  type RuntimeTool,
} from '../../tools/index.js';
import { loadQwenRuntimeConfig } from './env.js';

export interface QwenRuntime {
  contextBuilder: ContextBuilder;
  planner: PlannerCore;
  react: ReactCore;
  plannerStepReact: ReactCore;
  code: ReactCore;
  modelName: string;
}

type ToolBoundModel = Runnable<BaseLanguageModelInput, AIMessage>;

export async function createQwenRuntime(): Promise<QwenRuntime> {
  const config = loadQwenRuntimeConfig();
  const tools = createRuntimeTools();
  const plannerStepTools = createPlannerStepRuntimeTools();
  const codeTools = createCodeRuntimeTools();
  const model = new QwenReactModel({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.chatModel,
    tools,
  });
  const codeModel = new QwenReactModel({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.chatModel,
    tools: codeTools,
  });
  const plannerStepModel = new QwenReactModel({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.chatModel,
    tools: plannerStepTools,
  });
  const plannerModel = new ChatOpenAI({
    apiKey: config.apiKey,
    model: config.chatModel,
    temperature: 0.1,
    streaming: false,
    configuration: {
      baseURL: config.baseUrl,
    },
  });

  return {
    contextBuilder: new ContextBuilder(),
    modelName: config.chatModel,
    planner: new PlannerCore({
      model: {
        invoke: async messages => plannerModel.invoke(messages),
      },
    }),
    react: new ReactCore({
      model,
      tools,
      streaming: true,
      maxIterations: 8,
    }),
    plannerStepReact: new ReactCore({
      model: plannerStepModel,
      tools: plannerStepTools,
      streaming: true,
      maxIterations: 12,
    }),
    code: new ReactCore({
      model: codeModel,
      tools: codeTools,
      streaming: true,
      maxIterations: 12,
    }),
  };
}

class QwenReactModel {
  private readonly model: ChatOpenAI;
  private readonly modelWithTools: ToolBoundModel;

  constructor(input: {
    apiKey: string;
    baseUrl: string;
    model: string;
    tools: RuntimeTool[];
  }) {
    this.model = new ChatOpenAI({
      apiKey: input.apiKey,
      model: input.model,
      temperature: 0.2,
      streaming: true,
      configuration: {
        baseURL: input.baseUrl,
      },
    });
    this.modelWithTools = this.model.bindTools(createOpenAIToolDefinitions(input.tools), {
      tool_choice: 'auto',
    }) as ToolBoundModel;
  }

  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    return this.modelWithTools.invoke(messages);
  }

  async *stream(messages: BaseMessage[]): AsyncIterable<ReactCoreStreamChunk> {
    for await (const chunk of await this.modelWithTools.stream(messages)) {
      const streamChunk = chunk as unknown as {
        content?: unknown;
        usage_metadata?: unknown;
        response_metadata?: unknown;
        tool_call_chunks?: Array<{
          index?: number;
          id?: string;
          name?: string;
          args?: string;
        }>;
      };
      yield {
        content: streamChunk.content,
        usage: extractModelTokenUsage(streamChunk),
        tool_call_chunks: streamChunk.tool_call_chunks?.map(toolCallChunk => ({
          index: toolCallChunk.index,
          id: toolCallChunk.id,
          name: toolCallChunk.name,
          args: toolCallChunk.args,
        })),
      };
    }
  }

}

function extractModelTokenUsage(value: {
  usage_metadata?: unknown;
  response_metadata?: unknown;
}): AgentModelTokenUsage | undefined {
  return normalizeTokenUsage(value.usage_metadata)
    ?? normalizeTokenUsage((value.response_metadata as { tokenUsage?: unknown; usage?: unknown } | undefined)?.tokenUsage)
    ?? normalizeTokenUsage((value.response_metadata as { tokenUsage?: unknown; usage?: unknown } | undefined)?.usage);
}

function normalizeTokenUsage(value: unknown): AgentModelTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = readNumber(value, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const outputTokens = readNumber(value, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  const totalTokens = readNumber(value, ['total_tokens', 'totalTokens']);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined),
    source: 'provider',
  };
}

function readNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
