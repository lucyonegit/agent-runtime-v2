import type { AgentInputRequest } from './input-request.js';
import type { AgentMessage } from './message.js';
import type { AgentSessionTokenStats } from './token-usage.js';
import type { AgentTask } from './task.js';

export enum AgentSessionPatchType {
  UserMessageCreated = 'user.message.created',
  PlannerPlanCreated = 'planner.plan.created',
  ModelOutputDelta = 'model.output.delta',
  ModelOutputCompleted = 'model.output.completed',
  ToolResultCompleted = 'tool.result.completed',
  ToolResultFailed = 'tool.result.failed',
  ToolInputRequired = 'tool.input.required',
  TaskStatusChanged = 'task.status.changed',
  ContextUsageUpdated = 'context.usage.updated',
}

export type AgentSessionPatch =
  | {
      type: AgentSessionPatchType.UserMessageCreated;
      sessionId: string;
      message: AgentMessage;
    }
  | {
      type: AgentSessionPatchType.PlannerPlanCreated;
      sessionId: string;
      message: AgentMessage;
    }
  | {
      type: AgentSessionPatchType.ModelOutputDelta;
      sessionId: string;
      taskId: string;
      messageId: string;
      channel: NonNullable<AgentMessage['channel']>;
      outputId: string;
      delta: string;
    }
  | {
      type: AgentSessionPatchType.ModelOutputCompleted;
      sessionId: string;
      outputId: string;
      message: AgentMessage;
    }
  | {
      type: AgentSessionPatchType.ToolResultCompleted;
      sessionId: string;
      message: AgentMessage;
    }
  | {
      type: AgentSessionPatchType.ToolResultFailed;
      sessionId: string;
      message: AgentMessage;
    }
  | {
      type: AgentSessionPatchType.ToolInputRequired;
      sessionId: string;
      request: AgentInputRequest;
    }
  | {
      type: AgentSessionPatchType.TaskStatusChanged;
      sessionId: string;
      task: AgentTask;
    }
  | {
      type: AgentSessionPatchType.ContextUsageUpdated;
      sessionId: string;
      stats: AgentSessionTokenStats;
    };
