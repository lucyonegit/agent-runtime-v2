import type { AgentArtifact } from './artifact.js';
import type { AgentManagedProcess } from './managed-process.js';
import type { AgentMessage, AgentMessageChannel } from './message.js';
import type { AgentModelUsageStats } from './model-call.js';
import type { AgentActivePlan } from './plan.js';
import type { AgentTask } from './task.js';
import type { AgentTaskRun } from './task-run.js';
import type { AgentToolCall } from './tool-call.js';
import type { AgentUserInputRequest } from './user-input-request.js';

export type AgentRealtimeEvent =
  | {
      type: 'message.delta';
      eventId: string;
      sessionId: string;
      taskId: string;
      messageId: string;
      outputId: string;
      channel: AgentMessageChannel;
      delta: string;
    }
  | {
      type: 'tool_call.preview';
      eventId: string;
      sessionId: string;
      taskId: string;
      messageId: string;
      outputId: string;
      toolCallIndex?: number;
      modelToolCallId: string;
      toolName: string;
      observedAtMs: number;
    }
  | {
      type: 'message.discarded';
      eventId: string;
      sessionId: string;
      taskId: string;
      messageId: string;
      outputId: string;
      reason: string;
    }
  | { type: 'message.upserted'; sessionId: string; message: AgentMessage }
  | { type: 'task.upserted'; sessionId: string; task: AgentTask }
  | { type: 'task_run.upserted'; sessionId: string; taskRun: AgentTaskRun }
  | { type: 'plan.updated'; sessionId: string; plan: AgentActivePlan }
  | { type: 'plan.cleared'; sessionId: string; taskId: string }
  | { type: 'tool_call.upserted'; sessionId: string; toolCall: AgentToolCall }
  | { type: 'user_input.upserted'; sessionId: string; request: AgentUserInputRequest }
  | { type: 'model_usage.updated'; sessionId: string; stats: AgentModelUsageStats }
  | { type: 'artifact.upserted'; sessionId: string; artifact: AgentArtifact }
  | { type: 'managed_process.upserted'; sessionId: string; process: AgentManagedProcess };
