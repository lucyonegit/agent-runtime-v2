import type { ContextPurpose, ContextScope } from './context-purpose.js';
import { messagesInGroup, type MessageGroup } from './message-group-builder.js';

export interface ContextFilterInput {
  purpose: ContextPurpose;
  scope: ContextScope;
}

export class ContextFilter {
  filter(groups: MessageGroup[], input: ContextFilterInput): MessageGroup[] {
    const originalGoal = findOriginalGoal(groups, input.scope);
    return groups.filter(group => {
      const messages = messagesInGroup(group);
      if (messages.some(message => message.visibility === 'internal')) return false;
      if (messages.some(message => message.messageType === 'progress')) return false;
      if (group === originalGoal) return true;
      if (input.scope.kind === 'session_history') return true;

      const jobId = messages[0]?.jobId;
      const stepRunId = messages[0]?.stepRunId;
      const currentJobId = input.scope.jobId;
      const currentStepRunId = input.scope.kind === 'step_run'
        ? input.scope.stepRunId
        : undefined;
      switch (input.purpose) {
        case 'plan_final':
          return group.type === 'step_output' && jobId === currentJobId;
        case 'step_execution':
          return (
            group.type === 'step_output' && jobId === currentJobId
          ) || (
            jobId === currentJobId
            && stepRunId === currentStepRunId
            && group.type !== 'step_output'
          );
        case 'job_execution':
          return (
            jobId === currentJobId
            && (!stepRunId || stepRunId === currentStepRunId)
          )
            || jobId !== currentJobId;
        case 'code_execution':
          return jobId === currentJobId
            && (!stepRunId || stepRunId === currentStepRunId);
        case 'conversation':
        case 'context_compression':
          return true;
      }
    });
  }
}

function findOriginalGoal(groups: MessageGroup[], scope: ContextScope): MessageGroup | undefined {
  if (scope.kind === 'session_history') return undefined;
  return groups.find(group => {
    const message = messagesInGroup(group)[0];
    return message?.jobId === scope.jobId
      && message.messageType === 'user_message'
      && message.content === scope.originalGoal;
  });
}
