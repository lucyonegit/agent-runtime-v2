import type {
  AgentStore,
  SaveUserInputAnswerResult,
} from '../../../storage/agent-store.js';
import { mapStoreError } from '../../../runtime/errors/runtime-error.js';
import { projectSensitiveAnswers } from '../../../view/session-view.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import type { JobFlowClock } from '../shared/job-flow.helper.js';

export interface AnswerUserInputRequestInput {
  requestId: string;
  expectedVersion: number;
  clientAnswerId: string;
  answer: unknown;
  answerMessageId?: string;
}

export class AnswerUserInputFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly workerId: string,
    private readonly jobLeaseMs: number,
    private readonly clock: JobFlowClock,
    private readonly nextMessageId: () => string,
    private readonly nextAttemptId: () => string,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher
  ) {}

  async execute(
    input: AnswerUserInputRequestInput
  ): Promise<SaveUserInputAnswerResult> {
    const nowMs = this.clock.nowMs();
    let result: SaveUserInputAnswerResult;
    try {
      result = await this.store.execution.answerUserInput({
        ...input,
        answerMessageId: input.answerMessageId ?? this.nextMessageId(),
        workerId: this.workerId,
        attemptId: this.nextAttemptId(),
        nowMs,
        leaseUntilMs: nowMs + this.jobLeaseMs,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
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
