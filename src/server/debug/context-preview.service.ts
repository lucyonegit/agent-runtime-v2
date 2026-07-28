import { isAIMessage, isToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ContextConfig } from '../../config/runtime-config.js';
import {
  ContextInspectionService,
  type ContextQuery,
} from '../../orchestration/context-inspection.service.js';
import type { RuntimeTool } from '../../runtime/execution/tool-executor.js';
import {
  buildStableEnvironmentContext,
  TASK_AGENT_PROMPT_ID,
  TASK_AGENT_PROMPT_VERSION,
  TASK_AGENT_SYSTEM_PROMPT,
  TASK_AGENT_SYSTEM_PROMPT_VERSION,
} from '../../runtime/prompting/task-agent-prompt.js';
import type { AgentStore } from '../../storage/agent-store.js';
import type { ContextPreviewMessage, ContextPreviewV2 } from './context-preview-contract.js';

export interface ContextPreviewServiceOptions {
  store: AgentStore;
  tools: RuntimeTool[];
  contextWindowTokens: number;
  outputTokenLimit: number;
  inputTokenLimit: number;
  sandboxRoot?: string;
  shellPath?: string;
  contextConfig: ContextConfig;
  clock?: { nowMs(): number };
}

export class ContextPreviewService {
  readonly #inspection: ContextInspectionService;

  constructor(options: ContextPreviewServiceOptions) {
    this.#inspection = new ContextInspectionService({
      store: options.store,
      tools: options.tools.map(item => item.tool),
      systemPrompt: TASK_AGENT_SYSTEM_PROMPT,
      systemPromptVersion: TASK_AGENT_SYSTEM_PROMPT_VERSION,
      promptId: TASK_AGENT_PROMPT_ID,
      promptVersion: TASK_AGENT_PROMPT_VERSION,
      contextWindowTokens: options.contextWindowTokens,
      outputTokenLimit: options.outputTokenLimit,
      inputTokenLimit: options.inputTokenLimit,
      getStableContext: sessionId => buildStableEnvironmentContext({
        sandboxRoot: options.sandboxRoot ?? '.agent-sandbox',
        sessionId,
        shellPath: options.shellPath,
      }),
      contextConfig: options.contextConfig,
      clock: options.clock,
    });
  }

  preview(sessionId: string): Promise<ContextPreviewV2> {
    return this.#preview({ kind: 'next_turn', sessionId });
  }

  previewTask(taskId: string): Promise<ContextPreviewV2> {
    return this.#preview({ kind: 'task', taskId });
  }

  previewModelCall(modelCallId: string): Promise<ContextPreviewV2> {
    return this.#preview({ kind: 'model_call', modelCallId });
  }

  async #preview(query: ContextQuery): Promise<ContextPreviewV2> {
    const snapshot = await this.#inspection.inspect(query);
    return {
      schemaVersion: 2,
      debugOnly: true,
      generatedAtMs: snapshot.generatedAtMs,
      sessionId: snapshot.sessionId,
      query,
      verification: snapshot.verification,
      ...(snapshot.basedOnLatestTaskId
        ? { basedOnLatestTaskId: snapshot.basedOnLatestTaskId }
        : {}),
      systemPromptVersion: snapshot.systemPromptVersion,
      estimatedInputTokens: snapshot.input.estimatedTokens,
      limits: {
        contextWindowTokens: snapshot.contextWindowTokens,
        outputTokenLimit: snapshot.outputTokenLimit,
        inputTokenLimit: snapshot.input.inputTokenLimit,
      },
      ...(snapshot.input.compactedThroughRowId === undefined
        ? {}
        : { compactedThroughRowId: snapshot.input.compactedThroughRowId }),
      projectedToolResultMessageIds: snapshot.input.projectedToolResultMessageIds,
      manifest: snapshot.input.inputManifest,
      messages: snapshot.input.messages.map(toPreviewMessage),
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
        toolCalls: toolCalls.map(call => ({ id: call.id!, name: call.name, args: call.args })),
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
