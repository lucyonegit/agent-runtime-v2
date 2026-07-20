import type { AgentJob } from './job.js';
import type { AgentMessage, AgentMessageChannel } from './message.js';
import type { AgentModelUsageStats } from './model-call.js';
import type { AgentPlan, AgentPlanStep } from './plan.js';
import type { AgentToolInvocation } from './tool-invocation.js';
import type { AgentUserInputRequest } from './user-input-request.js';

export const AGENT_REALTIME_ENTITY_EVENT_TYPES = [
  'message.upserted',
  'job.upserted',
  'plan.upserted',
  'plan_step.upserted',
  'tool_invocation.upserted',
  'user_input.upserted',
  'model_usage.updated',
] as const;

export type AgentRealtimeEvent =
  | {
      type: 'message.delta';
      eventId: string;
      sessionId: string;
      jobId: string;
      planId?: string;
      planStepId?: string;
      messageId: string;
      outputId: string;
      channel: AgentMessageChannel;
      delta: string;
    }
  | {
      type: 'message.discarded';
      eventId: string;
      sessionId: string;
      jobId: string;
      messageId: string;
      outputId: string;
      reason: string;
    }
  | { type: 'message.upserted'; sessionId: string; message: AgentMessage }
  | { type: 'job.upserted'; sessionId: string; job: AgentJob }
  | { type: 'plan.upserted'; sessionId: string; plan: AgentPlan }
  | { type: 'plan_step.upserted'; sessionId: string; step: AgentPlanStep }
  | { type: 'tool_invocation.upserted'; sessionId: string; invocation: AgentToolInvocation }
  | { type: 'user_input.upserted'; sessionId: string; request: AgentUserInputRequest }
  | { type: 'model_usage.updated'; sessionId: string; stats: AgentModelUsageStats };
