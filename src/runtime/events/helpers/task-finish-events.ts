import type { AgentRealtimeEvent } from '../../../domain/index.js';
import type { FinishTaskResult } from '../../../storage/agent-store.js';

/** Complete best-effort projection batch for one committed Task terminalization. */
export function taskFinishEvents(result: FinishTaskResult): AgentRealtimeEvent[] {
  const sessionId = result.task.sessionId;
  return [
    ...result.toolCalls.map(toolCall => ({
      type: 'tool_call.upserted' as const,
      sessionId,
      toolCall,
    })),
    ...result.userInputRequests.map(request => ({
      type: 'user_input.upserted' as const,
      sessionId,
      request,
    })),
    ...(result.taskRun ? [{
      type: 'task_run.upserted' as const,
      sessionId,
      taskRun: result.taskRun,
    }] : []),
    { type: 'task.upserted', sessionId, task: result.task },
    ...(result.planCleared ? [{
      type: 'plan.cleared' as const,
      sessionId,
      taskId: result.task.id,
    }] : []),
  ];
}
