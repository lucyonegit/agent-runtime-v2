import type {
  AgentToolCall,
  AgentUserInputAnswerMode,
  AgentUserInputSchema,
  AgentUserInputSource,
} from '../domain/index.js';
import type { UsageMetadata } from '@langchain/core/messages';

export const LOOP_EVENT_TYPES = {
  ModelOutputDelta: 'model.output.delta',
  ModelOutputCompleted: 'model.output.completed',
  ToolResultCompleted: 'tool.result.completed',
  ToolResultFailed: 'tool.result.failed',
  ToolInputRequired: 'tool.input.required',
} as const;

export type LoopMessageChannel = 'normal' | 'progress' | 'final';

export interface ToolUserInputRequest {
  source: AgentUserInputSource;
  answerMode: AgentUserInputAnswerMode;
  prompt: string;
  inputSchema: AgentUserInputSchema;
  title?: string;
  sensitiveAnswer?: boolean;
}

export type LoopEvent =
  | {
      type: typeof LOOP_EVENT_TYPES.ModelOutputDelta;
      outputId: string;
      channel: LoopMessageChannel;
      delta: string;
    }
  | {
      type: typeof LOOP_EVENT_TYPES.ModelOutputCompleted;
      outputId: string;
      content: string;
      toolCalls: AgentToolCall[];
      usage?: UsageMetadata;
    }
  | {
      type: typeof LOOP_EVENT_TYPES.ToolResultCompleted;
      toolCallId: string;
      toolName: string;
      content: string;
      result?: unknown;
      durationMs: number;
    }
  | {
      type: typeof LOOP_EVENT_TYPES.ToolResultFailed;
      toolCallId: string;
      toolName: string;
      code: string;
      message: string;
      details?: unknown;
      durationMs: number;
    }
  | {
      type: typeof LOOP_EVENT_TYPES.ToolInputRequired;
      toolCallId: string;
      toolName: string;
      request: ToolUserInputRequest;
    };
