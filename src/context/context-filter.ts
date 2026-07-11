import type { ContextPurpose } from './context-purpose.js';
import { messagesInGroup, type MessageGroup } from './message-group-builder.js';

export interface ContextFilterInput {
  purpose: ContextPurpose;
  currentJobId: string;
  currentStepRunId?: string;
}

export class ContextFilter {
  filter(groups: MessageGroup[], input: ContextFilterInput): MessageGroup[] {
    const originalGoal = findOriginalGoal(groups, input.currentJobId);
    return groups.filter(group => {
      const messages = messagesInGroup(group);
      if (messages.some(message => message.visibility === 'internal')) return false;
      if (messages.some(message => message.messageType === 'progress')) return false;
      if (group === originalGoal) return true;

      const jobId = messages[0]?.jobId;
      const stepRunId = messages[0]?.stepRunId;
      switch (input.purpose) {
        case 'plan_final':
          return group.type === 'step_output' && jobId === input.currentJobId;
        case 'step_execution':
          return (
            group.type === 'step_output' && jobId === input.currentJobId
          ) || (
            jobId === input.currentJobId
            && stepRunId === input.currentStepRunId
            && group.type !== 'step_output'
          );
        case 'job_execution':
          return (
            jobId === input.currentJobId
            && (!stepRunId || stepRunId === input.currentStepRunId)
          )
            || jobId !== input.currentJobId;
        case 'code_execution':
          return jobId === input.currentJobId
            && (!stepRunId || stepRunId === input.currentStepRunId);
        case 'conversation':
        case 'context_compression':
          return true;
      }
    });
  }
}

function findOriginalGoal(groups: MessageGroup[], jobId: string): MessageGroup | undefined {
  return groups.find(group => {
    const message = messagesInGroup(group)[0];
    return message?.jobId === jobId && message.messageType === 'user_message';
  });
}
