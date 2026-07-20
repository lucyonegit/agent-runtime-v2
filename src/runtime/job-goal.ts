import type { AgentJob, AgentMessage } from '../domain/index.js';

const JOB_GOAL_MESSAGE_ID_KEY = 'goalMessageId';

export function withGoalMessageId(
  metadata: Record<string, unknown> | undefined,
  messageId: string
): Record<string, unknown> {
  return { ...metadata, [JOB_GOAL_MESSAGE_ID_KEY]: messageId };
}

export function jobGoalMessageId(job: Pick<AgentJob, 'metadata'>): string | undefined {
  const value = job.metadata?.[JOB_GOAL_MESSAGE_ID_KEY];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function resolveJobGoalMessage(
  job: Pick<AgentJob, 'id' | 'metadata'>,
  messages: AgentMessage[]
): AgentMessage | undefined {
  const referencedId = jobGoalMessageId(job);
  if (referencedId) {
    const referenced = messages.find(message => (
      message.id === referencedId
      && message.role === 'user'
      && message.messageType === 'user_message'
    ));
    if (referenced) return referenced;
  }
  return messages.find(message => (
    message.jobId === job.id
    && message.role === 'user'
    && message.messageType === 'user_message'
  ));
}
