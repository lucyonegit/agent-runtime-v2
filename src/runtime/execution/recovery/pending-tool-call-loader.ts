import type { AgentTask } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';

/** Rebuilds only the unfinished tool batch referenced by the durable checkpoint. */
export class PendingToolCallLoader {
  constructor(private readonly store: AgentStore) {}

  async load(task: AgentTask, callMessageId?: string) {
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
