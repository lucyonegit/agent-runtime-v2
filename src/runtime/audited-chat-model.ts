import { createHash, randomUUID } from 'node:crypto';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  AIMessageChunk,
  coerceMessageLikeToMessage,
  type UsageMetadata,
} from '@langchain/core/messages';
import { Runnable, type RunnableConfig } from '@langchain/core/runnables';
import type {
  AgentContextInputManifest,
  AgentModelCallType,
  AgentRealtimeEvent,
} from '../domain/index.js';
import type { AgentStore } from '../storage/agent-store.js';

export interface AuditedChatModelOptions {
  delegate: Runnable<BaseLanguageModelInput, AIMessageChunk>;
  store: AgentStore;
  workerId: string;
  target: { sessionId: string; jobId: string; stepRunId?: string; attemptId: string };
  callType: AgentModelCallType;
  logicalCallKey: string;
  provider: string;
  model: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  baseManifest: AgentContextInputManifest;
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
    const callId = await this.#start(input);
    try {
      const response = await this.#options.delegate.invoke(input, options);
      await this.#complete(callId, response.usage_metadata, {
        resultType: response.tool_calls?.length ? 'tool_calls' : 'text',
        resultPayload: { content: response.content, responseMetadata: response.response_metadata },
        toolNames: response.tool_calls?.map(call => call.name),
      });
      return response;
    } catch (error) {
      await this.#fail(callId, error);
      throw error;
    }
  }

  async *_streamIterator(
    input: BaseLanguageModelInput,
    options?: Partial<RunnableConfig>
  ): AsyncGenerator<AIMessageChunk> {
    const callId = await this.#start(input);
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
        resultType: response.tool_calls?.length ? 'tool_calls' : 'text',
        resultPayload: { content: response.content, responseMetadata: response.response_metadata },
        toolNames: response.tool_calls?.map(call => call.name),
      });
      completed = true;
    } catch (error) {
      await this.#fail(callId, error);
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

  async #start(input: BaseLanguageModelInput): Promise<string> {
    this.#logicalCallNo += 1;
    const id = this.#ids.modelCallId();
    const serialized = serializeModelInput(input);
    await this.#options.store.startModelCall({
      id,
      sessionId: this.#options.target.sessionId,
      jobId: this.#options.target.jobId,
      stepRunId: this.#options.target.stepRunId,
      attemptId: this.#options.target.attemptId,
      workerId: this.#options.workerId,
      logicalCallKey: `${this.#options.logicalCallKey}:${this.#logicalCallNo}`,
      callAttemptNo: 1,
      callType: this.#options.callType,
      provider: this.#options.provider,
      model: this.#options.model,
      contextRulesVersion: this.#options.baseManifest.contextRulesVersion,
      inputManifest: this.#options.baseManifest,
      inputChecksum: sha256(serialized),
      maxContextTokens: this.#options.maxContextTokens,
      reservedOutputTokens: this.#options.reservedOutputTokens,
      estimatedInputTokens: Math.max(1, Math.ceil(serialized.length / 4)),
      nowMs: this.#clock.nowMs(),
    });
    return id;
  }

  async #complete(
    id: string,
    usage: UsageMetadata | undefined,
    result: { resultType: string; resultPayload: unknown; toolNames?: string[] }
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

function usageFields(usage: UsageMetadata | undefined) {
  return usage ? {
    actualInputTokens: usage.input_tokens,
    actualOutputTokens: usage.output_tokens,
    actualTotalTokens: usage.total_tokens,
    cacheReadInputTokens: usage.input_token_details?.cache_read,
    cacheWriteInputTokens: usage.input_token_details?.cache_creation,
  } : {};
}

function serializeModelInput(input: BaseLanguageModelInput): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return JSON.stringify(input.map(coerceMessageLikeToMessage).map(message => message.toDict()));
  }
  return JSON.stringify(input.toChatMessages().map(message => message.toDict()));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isContextOverflow(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { code?: unknown }).code === 'context_overflow');
}
