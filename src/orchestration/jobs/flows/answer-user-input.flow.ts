import type { SaveUserInputAnswerResult } from '../../../storage/agent-store.js';
import { projectSensitiveAnswers } from '../../../view/session-view.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import {
  JobStateTransitions,
  type SaveUserInputAnswerInput,
} from '../shared/job-state-transitions.js';

export type AnswerUserInputRequestInput = SaveUserInputAnswerInput;

export class AnswerUserInputFlow {
  constructor(
    private readonly state: JobStateTransitions,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher
  ) {}

  async execute(
    input: Omit<AnswerUserInputRequestInput, 'answerMessageId'>
  ): Promise<SaveUserInputAnswerResult> {
    const result = await this.state.answerUserInput(input);
    const projection = projectSensitiveAnswers(
      [result.answerMessage],
      result.invocation ? [result.invocation] : [],
      [result.request]
    );
    await this.events.publishAll([
      {
        type: 'message.upserted',
        sessionId: result.job.sessionId,
        message: projection.messages[0]!,
      },
      ...(projection.invocations[0] ? [{
        type: 'tool_invocation.upserted' as const,
        sessionId: result.job.sessionId,
        invocation: projection.invocations[0],
      }] : []),
      {
        type: 'user_input.upserted',
        sessionId: result.job.sessionId,
        request: projection.requests[0]!,
      },
      { type: 'job.upserted', sessionId: result.job.sessionId, job: result.job },
    ]);
    if (result.shouldResume) this.execution.dispatch(result.job.id);
    return result;
  }
}
