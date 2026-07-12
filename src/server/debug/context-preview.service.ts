import { isAIMessage, isToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
  ContextInspectionService,
  type ContextInspectionStore,
} from '../../orchestration/context-inspection.service.js';
import { STEP_OUTPUT_INSTRUCTION } from '../../planner/planner-prompts.js';
import type { RuntimeTool } from '../../runtime/tool-executor.js';
import {
  JOB_EXECUTION_SYSTEM_PROMPT,
  RUNTIME_SYSTEM_PROMPT_VERSION,
  WORKSPACE_TOOL_ROUTING_INSTRUCTION,
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

  constructor(private readonly options: ContextPreviewServiceOptions) {
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
      stepSystemPrompt: `Execute only the current PlanStep. ${WORKSPACE_TOOL_ROUTING_INSTRUCTION} ${STEP_OUTPUT_INSTRUCTION}`,
      compressionMessageThreshold: options.compressionMessageThreshold ?? 50,
      clock: options.clock,
    });
  }

  async preview(sessionId: string): Promise<ContextPreviewV1> {
    const snapshot = await this.#inspection.inspect({ kind: 'next_turn', sessionId });
    return {
      schemaVersion: 1,
      debugOnly: true,
      generatedAtMs: snapshot.generatedAtMs,
      sessionId: snapshot.sessionId,
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
      messages: snapshot.built.messages.map(toPreviewMessage),
    };
  }
}

function toPreviewMessage(message: BaseMessage, index: number): ContextPreviewMessage {
  const type = message.getType();
  if (isAIMessage(message)) {
    const toolCalls = message.tool_calls ?? [];
    return {
      index,
      type: 'ai',
      content: message.content,
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
    ...(message.name ? { name: message.name } : {}),
  };
}
