import { createHash, randomUUID } from 'node:crypto';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  AIMessageChunk,
  coerceMessageLikeToMessage,
  mapChatMessagesToStoredMessages,
  type BaseMessage,
  type StoredMessage,
  type UsageMetadata,
} from '@langchain/core/messages';
import { Runnable, type RunnableConfig } from '@langchain/core/runnables';
import type {
  AgentContextInputManifest,
  AgentModelCallType,
  AgentRealtimeEvent,
} from '../domain/index.js';
import type { AgentStore } from '../storage/agent-store.js';
import { canonicalJson } from './transaction-commands.js';
import { estimateTextTokens } from './context/token-budget.js';

export interface AuditedChatModelOptions {
  delegate: Runnable<BaseLanguageModelInput, AIMessageChunk>;
  store: AgentStore;
  workerId: string;
  target: {
    sessionId: string;
    jobId: string;
    attemptId: string;
    attemptNo: number;
  };
  callType: AgentModelCallType;
  logicalCallKey: string;
  provider: string;
  model: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  baseManifest: AgentContextInputManifest | (() => AgentContextInputManifest);
  publisher?: { publish(event: AgentRealtimeEvent): void | Promise<void> };
  ids?: { modelCallId(): string };
  clock?: { nowMs(): number };
}

export class AuditedChatModel extends Runnable<BaseLanguageModelInput, AIMessageChunk> {
  static lc_name(): string { return 'AuditedChatModel'; }
  readonly lc_namespace = ['agent_runtime', 'model'];
  readonly #options: AuditedChatModelOptions;
  readonly #ids: { modelCallId(): string };
  readonly #clock: { nowMs(): number };
  #logicalCallNo = 0;

  constructor(options: AuditedChatModelOptions) {
    super();
    this.#options = options;
    this.#ids = options.ids ?? { modelCallId: () => `model_call_${randomUUID()}` };
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async invoke(input: BaseLanguageModelInput, options?: Partial<RunnableConfig>): Promise<AIMessageChunk> {
    const outputId = runtimeOutputId(options);
    const callId = await this.#start(input, outputId);
    try {
      const response = await this.#options.delegate.invoke(input, options);
      await this.#complete(callId, response.usage_metadata, {
        outputId,
        ...modelResult(response),
      });
      return response;
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) {
        await this.#cancel(callId, error);
      } else {
        await this.#fail(callId, error);
      }
      throw error;
    }
  }

  async *_streamIterator(
    input: BaseLanguageModelInput,
    options?: Partial<RunnableConfig>
  ): AsyncGenerator<AIMessageChunk> {
    const outputId = runtimeOutputId(options);
    const callId = await this.#start(input, outputId);
    let combined: AIMessageChunk | undefined;
    let completed = false;
    try {
      const stream = await this.#options.delegate.stream(input, options);
      for await (const chunk of stream) {
        combined = combined ? combined.concat(chunk) : chunk;
        yield chunk;
      }
      const response = combined ?? new AIMessageChunk('');
      await this.#complete(callId, response.usage_metadata, {
        outputId,
        ...modelResult(response),
      });
      completed = true;
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) {
        await this.#cancel(callId, error, combined?.usage_metadata);
      } else {
        await this.#fail(callId, error);
      }
      completed = true;
      throw error;
    } finally {
      if (!completed) {
        const cancelled = await this.#options.store.completeModelCall({
          id: callId,
          status: 'cancelled',
          usageSource: combined?.usage_metadata ? 'provider' : 'unavailable',
          ...usageFields(combined?.usage_metadata),
          errorCode: 'aborted',
          errorMessage: 'Model stream consumer stopped before completion.',
          nowMs: this.#clock.nowMs(),
        });
        await this.#publishUsage(cancelled.usage);
      }
    }
  }

  async #start(input: BaseLanguageModelInput, outputId: string | undefined): Promise<string> {
    this.#logicalCallNo += 1;
    const id = this.#ids.modelCallId();
    const inputMessages = storeModelInput(input);
    const serialized = canonicalJson(inputMessages);
    const manifest = typeof this.#options.baseManifest === 'function'
      ? this.#options.baseManifest()
      : this.#options.baseManifest;
    await this.#options.store.startModelCall({
      id,
      sessionId: this.#options.target.sessionId,
      jobId: this.#options.target.jobId,
      attemptId: this.#options.target.attemptId,
      workerId: this.#options.workerId,
      logicalCallKey: `${this.#options.logicalCallKey}:${this.#logicalCallNo}`,
      callAttemptNo: this.#options.target.attemptNo,
      callType: this.#options.callType,
      provider: this.#options.provider,
      model: this.#options.model,
      contextRulesVersion: manifest.contextRulesVersion,
      inputManifest: manifest,
      inputMessages,
      inputChecksum: sha256(serialized),
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
      estimatedInputTokens: Math.max(
        estimateTextTokens(serialized),
        manifestInputTokens(manifest)
      ),
      outputId,
      nowMs: this.#clock.nowMs(),
    });
    return id;
  }

  async #complete(
    id: string,
    usage: UsageMetadata | undefined,
    result: {
      outputId?: string;
      resultType: string;
      resultPayload: unknown;
      toolNames?: string[];
    }
  ): Promise<void> {
    const completed = await this.#options.store.completeModelCall({
      id,
      status: 'completed',
      usageSource: usage ? 'provider' : 'unavailable',
      ...usageFields(usage),
      ...result,
      nowMs: this.#clock.nowMs(),
    });
    await this.#publishUsage(completed.usage);
  }

  async #fail(id: string, error: unknown): Promise<void> {
    const completed = await this.#options.store.completeModelCall({
      id,
      status: 'failed',
      usageSource: 'unavailable',
      errorCode: isContextOverflow(error) ? 'context_overflow' : 'model_error',
      errorMessage: error instanceof Error ? error.message : 'Model call failed.',
      nowMs: this.#clock.nowMs(),
    });
    await this.#publishUsage(completed.usage);
  }

  async #cancel(id: string, error: unknown, usage?: UsageMetadata): Promise<void> {
    const completed = await this.#options.store.completeModelCall({
      id,
      status: 'cancelled',
      usageSource: usage ? 'provider' : 'unavailable',
      ...usageFields(usage),
      errorCode: 'aborted',
      errorMessage: error instanceof Error ? error.message : 'Model call was cancelled.',
      nowMs: this.#clock.nowMs(),
    });
    await this.#publishUsage(completed.usage);
  }

  async #publishUsage(stats: Awaited<ReturnType<AgentStore['completeModelCall']>>['usage']): Promise<void> {
    try {
      await this.#options.publisher?.publish({
        type: 'model_usage.updated',
        sessionId: this.#options.target.sessionId,
        stats,
      });
    } catch {
      // SessionView is authoritative when realtime delivery fails.
    }
  }
}

function runtimeOutputId(options: Partial<RunnableConfig> | undefined): string | undefined {
  const value = options?.configurable?.agentRuntimeOutputId;
  return typeof value === 'string' && value ? value : undefined;
}

function modelResult(response: AIMessageChunk) {
  const validCalls = response.tool_calls ?? [];
  const invalidCalls = response.invalid_tool_calls ?? [];
  const toolNames = [...validCalls, ...invalidCalls]
    .map(call => call.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  return {
    resultType: toolNames.length > 0 ? 'tool_calls' : 'text',
    resultPayload: {
      content: response.content,
      responseMetadata: response.response_metadata,
      ...(invalidCalls.length > 0 ? { invalidToolCalls: invalidCalls } : {}),
    },
    ...(toolNames.length > 0 ? { toolNames } : {}),
  };
}

function manifestInputTokens(manifest: AgentContextInputManifest): number {
  const breakdown = manifest.estimatedBreakdown;
  return breakdown.system + breakdown.tools + breakdown.summaries + breakdown.messages;
}

function usageFields(usage: UsageMetadata | undefined) {
  return usage ? {
    actualInputTokens: usage.input_tokens,
    actualOutputTokens: usage.output_tokens,
    actualTotalTokens: usage.total_tokens,
    cacheReadInputTokens: usage.input_token_details?.cache_read,
    cacheWriteInputTokens: usage.input_token_details?.cache_creation,
  } : {};
}

function storeModelInput(input: BaseLanguageModelInput): StoredMessage[] {
  let messages: BaseMessage[];
  if (typeof input === 'string') {
    messages = [coerceMessageLikeToMessage(['human', input])];
  } else if (Array.isArray(input)) {
    messages = input.map(coerceMessageLikeToMessage);
  } else {
    messages = input.toChatMessages();
  }
  return mapChatMessagesToStoredMessages(messages);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isContextOverflow(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { code?: unknown }).code === 'context_overflow');
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { name?: unknown }).name === 'AbortError');
}
