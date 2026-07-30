import type {
  AgentMessageToolCall,
  AgentArtifactDraft,
  AgentUserInputSchema,
} from '../../domain/index.js';
import type { UsageMetadata } from '@langchain/core/messages';

export const LOOP_EVENT_TYPES = {
  ModelOutputDelta: 'model.output.delta',
  ModelToolCallPreview: 'model.tool_call.preview',
  ModelOutputCompleted: 'model.output.completed',
  ModelOutputRejected: 'model.output.rejected',
  ToolResultCompleted: 'tool.result.completed',
  ToolResultFailed: 'tool.result.failed',
  ToolInputRequired: 'tool.input.required',
} as const;

export type LoopMessageChannel = 'normal' | 'progress' | 'final';

export interface ToolUserInputRequest {
  prompt: string;
  inputSchema: AgentUserInputSchema;
  title?: string;
  sensitiveAnswer?: boolean;
  expiresInMs?: number;
}

export type LoopEvent =
  | {
      type: typeof LOOP_EVENT_TYPES.ModelOutputDelta;
      outputId: string;
      channel: LoopMessageChannel;
      delta: string;
    }
  | {
      type: typeof LOOP_EVENT_TYPES.ModelToolCallPreview;
      outputId: string;
      toolCallIndex?: number;
      modelToolCallId: string;
      toolName: string;
      observedAtMs: number;
    }
  | {
      type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted;
      outputId: string;
      content: string;
      toolCalls: AgentMessageToolCall[];
      usage?: UsageMetadata;
    }
  | {
      type: typeof LOOP_EVENT_TYPES.ModelOutputRejected;
      outputId: string;
      reason: string;
    }
  | {
      type: typeof LOOP_EVENT_TYPES.ToolResultCompleted;
      modelToolCallId: string;
      toolName: string;
      content: string;
      result?: unknown;
      artifacts?: AgentArtifactDraft[];
      durationMs: number;
    }
  | {
      type: typeof LOOP_EVENT_TYPES.ToolResultFailed;
      modelToolCallId: string;
      toolName: string;
      executionStarted: boolean;
      outcomeUnknown: boolean;
      code: string;
      message: string;
      details?: unknown;
      durationMs: number;
    }
  | {
      type: typeof LOOP_EVENT_TYPES.ToolInputRequired;
      modelToolCallId: string;
      toolName: string;
      request: ToolUserInputRequest;
    };
