import type { AgentStore, SaveUserInputAnswerResult } from '../../../storage/agent-store.js';
import { mapStoreError, RuntimeError } from '../../../runtime/errors/runtime-error.js';
import { projectSensitiveAnswers } from '../../../view/session-view.js';
import { TaskEventPublisher } from '../shared/task-event-publisher.js';
import { TaskExecutionDispatcher } from '../shared/task-execution-dispatcher.js';
import type { TaskFlowClock } from '../shared/task-flow.helper.js';

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
    private readonly ownerId: string,
    private readonly ownershipTimeoutMs: number,
    private readonly clock: TaskFlowClock,
    private readonly nextMessageId: () => string,
    private readonly nextTaskRunId: () => string,
    private readonly events: TaskEventPublisher,
    private readonly execution: TaskExecutionDispatcher
  ) {}

  async execute(input: AnswerUserInputRequestInput): Promise<SaveUserInputAnswerResult> {
    const nowMs = this.clock.nowMs();
    let result: SaveUserInputAnswerResult;
    try {
      result = await this.store.execution.answerUserInput({
        ...input,
        answerMessageId: input.answerMessageId ?? this.nextMessageId(),
        taskRunId: this.nextTaskRunId(),
        ownerId: this.ownerId,
        nowMs,
        ownershipExpiresAtMs: nowMs + this.ownershipTimeoutMs,
      });
    } catch (error) {
      throw mapStoreError(error);
    }

    const projection = projectSensitiveAnswers(
      [result.answerMessage],
      [result.toolCall],
      [result.request]
    );
    await this.events.publishAll([{
      type: 'message.upserted',
      sessionId: result.task.sessionId,
      message: projection.messages[0]!,
    }]);
    if (result.taskFinish) {
      await this.events.publishTaskFinish(result.taskFinish);
    } else {
      await this.events.publishAll([
        { type: 'tool_call.upserted', sessionId: result.task.sessionId, toolCall: projection.toolCalls[0]! },
        { type: 'user_input.upserted', sessionId: result.task.sessionId, request: projection.requests[0]! },
        { type: 'task.upserted', sessionId: result.task.sessionId, task: result.task },
        ...(result.taskRun ? [{
          type: 'task_run.upserted' as const,
          sessionId: result.task.sessionId,
          taskRun: result.taskRun,
        }] : []),
      ]);
    }
    if (result.shouldResume) {
      if (!result.taskRun) {
        throw new RuntimeError(
          'storage_error',
          'User input resume committed without a TaskRun.'
        );
      }
      this.execution.dispatch({ taskId: result.task.id, taskRunId: result.taskRun.id });
    }
    return result;
  }
}
