import { createHash, randomUUID } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  AgentLoopModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
  ProviderTokenUsage,
} from '../agent-loop/model-port.js';
import type { AgentContextInputManifest, AgentModelCallType } from '../domain/index.js';
import type { AgentStore } from '../storage/agent-store.js';

export interface AuditedModelPortOptions {
  delegate: AgentLoopModelPort;
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
  ids?: { modelCallId(): string };
  clock?: { nowMs(): number };
}

export class AuditedModelPort implements AgentLoopModelPort {
  readonly #options: AuditedModelPortOptions;
  readonly #ids: { modelCallId(): string };
  readonly #clock: { nowMs(): number };
  #logicalCallNo = 0;

  constructor(options: AuditedModelPortOptions) {
    this.#options = options;
    this.#ids = options.ids ?? { modelCallId: () => `model_call_${randomUUID()}` };
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const callId = await this.#start(request);
    try {
      const response = await this.#options.delegate.invoke(request);
      await this.#complete(callId, response.usage, {
        resultType: response.toolCalls?.length ? 'tool_calls' : 'text',
        resultPayload: { content: response.content },
        toolNames: response.toolCalls?.map(call => call.name).filter((name): name is string => Boolean(name)),
      });
      return response;
    } catch (error) {
      await this.#fail(callId, error);
      throw error;
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    if (!this.#options.delegate.stream) {
      const response = await this.invoke(request);
      yield {
        content: response.content,
        toolCallChunks: response.toolCalls?.map((call, index) => ({
          index,
          id: call.id,
          name: call.name,
          args: JSON.stringify(call.args ?? {}),
        })),
        usage: response.usage,
      };
      return;
    }
    const callId = await this.#start(request);
    let usage: ProviderTokenUsage | undefined;
    const toolNames = new Set<string>();
    let content = '';
    let completed = false;
    try {
      for await (const chunk of this.#options.delegate.stream(request)) {
        usage = chunk.usage ?? usage;
        if (typeof chunk.content === 'string') content += chunk.content;
        chunk.toolCallChunks?.forEach(chunk_ => {
          if (chunk_.name) toolNames.add(chunk_.name);
        });
        yield chunk;
      }
      await this.#complete(callId, usage, {
        resultType: toolNames.size > 0 ? 'tool_calls' : 'text',
        resultPayload: { content },
        toolNames: [...toolNames],
      });
      completed = true;
    } catch (error) {
      await this.#fail(callId, error);
      completed = true;
      throw error;
    } finally {
      if (!completed) {
        await this.#options.store.completeModelCall({
          id: callId,
          status: 'cancelled',
          usageSource: usage?.source ?? 'unavailable',
          errorCode: 'aborted',
          errorMessage: 'Model stream consumer stopped before completion.',
          nowMs: this.#clock.nowMs(),
        });
      }
    }
  }

  async #start(request: ModelRequest): Promise<string> {
    this.#logicalCallNo += 1;
    const id = this.#ids.modelCallId();
    const serialized = serializeMessages(request.messages);
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
    usage: ProviderTokenUsage | undefined,
    result: { resultType: string; resultPayload: unknown; toolNames?: string[] }
  ): Promise<void> {
    await this.#options.store.completeModelCall({
      id,
      status: 'completed',
      usageSource: usage?.source ?? 'unavailable',
      actualInputTokens: usage?.inputTokens,
      actualOutputTokens: usage?.outputTokens,
      actualTotalTokens: usage?.totalTokens,
      cacheReadInputTokens: usage?.cacheReadInputTokens,
      cacheWriteInputTokens: usage?.cacheWriteInputTokens,
      ...result,
      nowMs: this.#clock.nowMs(),
    });
  }

  async #fail(id: string, error: unknown): Promise<void> {
    await this.#options.store.completeModelCall({
      id,
      status: 'failed',
      usageSource: 'unavailable',
      errorCode: isContextOverflow(error) ? 'context_overflow' : 'model_error',
      errorMessage: error instanceof Error ? error.message : 'Model call failed.',
      nowMs: this.#clock.nowMs(),
    });
  }
}

function serializeMessages(messages: BaseMessage[]): string {
  return JSON.stringify(messages.map(message => ({
    type: message.getType(),
    content: message.content,
  })));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isContextOverflow(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { code?: unknown }).code === 'context_overflow');
}
