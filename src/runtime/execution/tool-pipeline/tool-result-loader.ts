import type { AgentToolCall } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import { FatalToolExecutionError, type ToolExecutionResult } from '../../loop/agent-loop.js';

/** Loads the unique ToolMessage result for a ToolCall that already finished. */
export class ToolResultLoader {
  constructor(private readonly store: AgentStore) {}

  async load(toolCall: AgentToolCall): Promise<ToolExecutionResult> {
    if (!toolCall.resultMessageId) {
      return {
        type: 'failed',
        code: 'tool_failed',
        message: `ToolCall is ${toolCall.status} without a committed result message.`,
      };
    }
    const messages = await this.store.sessions.listMessages(toolCall.sessionId);
    const message = messages.find(candidate => candidate.id === toolCall.resultMessageId);
    if (!message?.toolResult) {
      throw new FatalToolExecutionError(
        'storage_error',
        `Committed ToolMessage ${JSON.stringify(toolCall.resultMessageId)} was not found.`
      );
    }
    if (message.toolResult.status === 'failed') {
      return {
        type: 'failed',
        code: message.toolResult.code ?? toolCall.error?.code ?? 'tool_failed',
        message: message.toolResult.error ?? toolCall.error?.message ?? 'Tool failed.',
        details: message.toolResult.details ?? toolCall.error?.details,
      };
    }
    return { type: 'completed', content: message.content, result: message.toolResult.result };
  }
}
