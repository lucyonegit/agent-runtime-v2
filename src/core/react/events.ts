import type {
  AgentInputResumeMode,
  AgentInputSchema,
  AgentInputSource,
  AgentMessageChannel,
  AgentModelTokenUsage,
  AgentToolCall,
} from './types.js';

export enum CoreStepEventType {
  ModelOutputDelta = 'model.output.delta',
  ModelOutputCompleted = 'model.output.completed',
  ToolResultCompleted = 'tool.result.completed',
  ToolResultFailed = 'tool.result.failed',
  ToolInputRequired = 'tool.input.required',
}

export interface CoreToolInputRequest {
  source: AgentInputSource;
  resumeMode: AgentInputResumeMode;
  prompt: string;
  input: AgentInputSchema;
  title?: string;
}

export type CoreStepEvent =
  | {
      type: CoreStepEventType.ModelOutputDelta;
      outputId: string;
      channel: AgentMessageChannel;
      delta: string;
    }
  | {
      type: CoreStepEventType.ModelOutputCompleted;
      outputId: string;
      channel: AgentMessageChannel;
      content: string;
      toolCalls?: AgentToolCall[];
      usage?: AgentModelTokenUsage;
    }
  | {
      type: CoreStepEventType.ToolResultCompleted;
      toolCallId: string;
      toolName: string;
      content: string;
      result?: unknown;
      durationMs: number;
    }
  | {
      type: CoreStepEventType.ToolResultFailed;
      toolCallId: string;
      toolName: string;
      error: string;
      details?: unknown;
      durationMs: number;
    }
  | {
      type: CoreStepEventType.ToolInputRequired;
      toolCallId: string;
      toolName: string;
      request: CoreToolInputRequest;
    };
