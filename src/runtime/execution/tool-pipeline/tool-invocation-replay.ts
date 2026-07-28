import type { AgentToolInvocation } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import {
  FatalToolExecutionError,
  type ToolExecutionResult,
} from '../../loop/agent-loop.js';

export class ToolInvocationReplay {
  constructor(private readonly store: AgentStore) {}

  async load(invocation: AgentToolInvocation): Promise<ToolExecutionResult> {
    if (!invocation.resultMessageId) {
      return {
        type: 'failed',
        code: 'tool_failed',
        message: `Tool invocation is ${invocation.status} without a committed result message.`,
      };
    }
    const messages = await this.store.sessions.listMessages(invocation.sessionId);
    const message = messages.find(candidate => candidate.id === invocation.resultMessageId);
    if (!message?.toolResult) {
      throw new FatalToolExecutionError(
        'storage_error',
        `Committed result message ${JSON.stringify(invocation.resultMessageId)} was not found.`
      );
    }
    if (message.toolResult.status === 'failed') {
      return {
        type: 'failed',
        code: invocation.error?.code ?? 'tool_failed',
        message: message.toolResult.error ?? invocation.error?.message ?? 'Tool failed.',
        details: invocation.error?.details,
      };
    }
    return { type: 'completed', content: message.content, result: message.toolResult.result };
  }
}
