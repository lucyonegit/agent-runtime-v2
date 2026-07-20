import { isAIMessage, isToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
  ContextInspectionService,
  type ContextQuery,
  type ContextInspectionStore,
} from '../../orchestration/context-inspection.service.js';
import type { RuntimeTool } from '../../runtime/tool-executor.js';
import {
  JOB_EXECUTION_SYSTEM_PROMPT,
  RUNTIME_SYSTEM_PROMPT_VERSION,
} from '../runtime/runtime-context-config.js';
import type { ContextPreviewMessage, ContextPreviewV1 } from './context-preview-contract.js';

export type ContextPreviewStore = ContextInspectionStore;

export interface ContextPreviewServiceOptions {
  store: ContextPreviewStore;
  tools: RuntimeTool[];
  provider: string;
  modelName: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  compressionMessageThreshold?: number;
  clock?: { nowMs(): number };
}

export class ContextPreviewService {
  readonly #inspection: ContextInspectionService;

  constructor(options: ContextPreviewServiceOptions) {
    this.#inspection = new ContextInspectionService({
      store: options.store,
      tools: options.tools.map(item => item.tool),
      model: {
        provider: options.provider,
        name: options.modelName,
        maxContextTokens: options.maxContextTokens,
        reservedOutputTokens: options.reservedOutputTokens,
      },
      systemPrompt: JOB_EXECUTION_SYSTEM_PROMPT,
      systemPromptVersion: RUNTIME_SYSTEM_PROMPT_VERSION,
      compressionMessageThreshold: options.compressionMessageThreshold ?? 50,
      clock: options.clock,
    });
  }

  preview(sessionId: string): Promise<ContextPreviewV1> {
    return this.#preview({ kind: 'next_turn', sessionId });
  }

  previewJob(jobId: string): Promise<ContextPreviewV1> {
    return this.#preview({ kind: 'job', jobId });
  }

  previewModelCall(modelCallId: string): Promise<ContextPreviewV1> {
    return this.#preview({ kind: 'model_call', modelCallId });
  }

  async #preview(query: ContextQuery): Promise<ContextPreviewV1> {
    const snapshot = await this.#inspection.inspect(query);
    return {
      schemaVersion: 1,
      debugOnly: true,
      generatedAtMs: snapshot.generatedAtMs,
      sessionId: snapshot.sessionId,
      query,
      verification: snapshot.verification,
      ...(snapshot.basedOnLatestJobId
        ? { basedOnLatestJobId: snapshot.basedOnLatestJobId }
        : {}),
      contextRulesVersion: snapshot.built.contextRulesVersion,
      systemPromptVersion: snapshot.systemPromptVersion,
      estimatedInputTokens: snapshot.built.estimatedInputTokens,
      compressionRecommended: snapshot.built.compressionRecommended,
      limits: {
        maxContextTokens: snapshot.maxContextTokens,
        reservedOutputTokens: snapshot.reservedOutputTokens,
      },
      manifest: snapshot.built.inputManifest,
      selection: {
        selectedBundleIds: snapshot.built.inputManifest.selectedBundleIds ?? [],
        summarizedBundleIds: snapshot.built.inputManifest.summarizedBundleIds ?? [],
        truncatedToolResultMessageIds:
          snapshot.built.inputManifest.truncatedToolResultMessageIds ?? [],
      },
      blockedDiagnostics: snapshot.built.blockedDiagnostics,
      messages: snapshot.built.messages.map((message, index) => (
        toPreviewMessage(message, index, snapshot.built.annotations[index])
      )),
    };
  }
}

function toPreviewMessage(
  message: BaseMessage,
  index: number,
  source?: ContextPreviewMessage['source']
): ContextPreviewMessage {
  const type = message.getType();
  if (isAIMessage(message)) {
    const toolCalls = message.tool_calls ?? [];
    return {
      index,
      type: 'ai',
      content: message.content,
      ...(source ? { source } : {}),
      ...(message.name ? { name: message.name } : {}),
      ...(toolCalls.length > 0 ? {
        toolCalls: toolCalls.map(call => ({
          id: call.id!,
          name: call.name,
          args: call.args,
        })),
      } : {}),
    };
  }
  if (isToolMessage(message)) {
    return {
      index,
      type: 'tool',
      content: message.content,
      ...(source ? { source } : {}),
      ...(message.name ? { name: message.name } : {}),
      toolCallId: message.tool_call_id,
    };
  }
  if (type !== 'system' && type !== 'human') {
    throw new TypeError(`Unsupported Context preview message type: ${JSON.stringify(type)}.`);
  }
  return {
    index,
    type: type === 'system' ? 'system' : 'human',
    content: message.content,
    ...(source ? { source } : {}),
    ...(message.name ? { name: message.name } : {}),
  };
}
