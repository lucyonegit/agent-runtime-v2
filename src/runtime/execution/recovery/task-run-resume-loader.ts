import type { AgentTask } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import type { AgentLoopResumeState } from '../../loop/agent-loop.js';

/** Rebuilds the exact AgentLoop continuation described by the latest durable checkpoint. */
export class TaskRunResumeLoader {
  constructor(private readonly store: AgentStore) {}

  async load(task: AgentTask): Promise<AgentLoopResumeState | undefined> {
    const checkpoint = await this.store.execution.getLatestCheckpoint(task.id);
    if (!checkpoint) return undefined;
    return {
      iterationNo: checkpoint.iterationNo,
      executedToolCalls: checkpoint.executedToolCalls,
      pendingToolCalls: await this.#loadPendingToolCalls(task, checkpoint.callMessageId),
    };
  }

  async #loadPendingToolCalls(task: AgentTask, callMessageId?: string) {
    if (!callMessageId) return [];
    const [messages, toolCalls] = await Promise.all([
      this.store.sessions.listMessages(task.sessionId),
      this.store.sessions.listToolCalls(task.sessionId),
    ]);
    const callMessage = messages.find(message => message.id === callMessageId);
    if (!callMessage?.toolCalls?.length) {
      throw new Error(`Checkpoint tool batch ${JSON.stringify(callMessageId)} has no call message.`);
    }
    const byModelCallId = new Map(
      toolCalls
        .filter(toolCall => toolCall.taskId === task.id && toolCall.callMessageId === callMessageId)
        .map(toolCall => [toolCall.modelToolCallId, toolCall])
    );
    return callMessage.toolCalls.flatMap(call => {
      const toolCall = byModelCallId.get(call.id);
      if (!toolCall) {
        throw new Error(`Checkpoint model tool call ${JSON.stringify(call.id)} has no ToolCall.`);
      }
      if (['completed', 'failed'].includes(toolCall.status)) return [];
      if (toolCall.status !== 'pending') {
        throw new Error(
          `Checkpoint model tool call ${JSON.stringify(call.id)} cannot resume from ${toolCall.status}.`
        );
      }
      return [{ ...call, args: toolCall.arguments }];
    });
  }
}
