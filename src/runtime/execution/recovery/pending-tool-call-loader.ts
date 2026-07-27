import type { AgentJob } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';

/** Rebuilds only the unfinished tool batch referenced by the durable checkpoint. */
export class PendingToolCallLoader {
  constructor(private readonly store: AgentStore) {}

  async load(job: AgentJob, callMessageId?: string) {
    if (!callMessageId) return [];
    const [messages, invocations] = await Promise.all([
      this.store.listSessionMessages(job.sessionId),
      this.store.listSessionToolInvocations(job.sessionId),
    ]);
    const callMessage = messages.find(message => message.id === callMessageId);
    if (!callMessage?.toolCalls?.length) {
      throw new Error(`Checkpoint tool batch ${JSON.stringify(callMessageId)} has no call message.`);
    }
    const byCallId = new Map(
      invocations
        .filter(invocation => invocation.jobId === job.id && invocation.callMessageId === callMessageId)
        .map(invocation => [invocation.toolCallId, invocation])
    );
    return callMessage.toolCalls.flatMap(call => {
      const invocation = byCallId.get(call.id);
      if (!invocation) {
        throw new Error(`Checkpoint tool call ${JSON.stringify(call.id)} has no invocation.`);
      }
      if (['completed', 'failed'].includes(invocation.status)) return [];
      if (invocation.status !== 'pending') {
        throw new Error(
          `Checkpoint tool call ${JSON.stringify(call.id)} cannot resume from ${invocation.status}.`
        );
      }
      return [{ ...call, args: invocation.arguments }];
    });
  }
}
