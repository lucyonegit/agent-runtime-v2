import type { AgentTask } from '../../domain/index.js';
import { mapStoreError } from '../../runtime/errors/runtime-error.js';
import type {
  AgentStore,
  CreateTaskWithUserMessageResult,
  SaveUserInputAnswerResult,
} from '../../storage/agent-store.js';
import type { RuntimeEventPublisher } from '../../runtime/events/runtime-event-publisher.js';
import { AnswerUserInputFlow, type AnswerUserInputRequestInput } from './flows/answer-user-input.flow.js';
import { CancelTaskFlow } from './flows/cancel-task.flow.js';
import { CreateTaskFlow, type CreateTaskInput } from './flows/create-task.flow.js';
import type { TaskExecutorPort } from './task-executor.js';
import { TaskRunStarter } from './shared/task-run-starter.js';
import { TaskEventPublisher } from './shared/task-event-publisher.js';
import { TaskExecutionDispatcher } from './shared/task-execution-dispatcher.js';
import { randomTaskFlowIds, type TaskFlowClock, type TaskFlowIds } from './shared/task-flow.helper.js';

export interface TaskManagerOptions {
  store: AgentStore;
  workerId: string;
  ownershipTimeoutMs: number;
  publisher: RuntimeEventPublisher;
  execution: TaskExecutorPort;
  clock?: TaskFlowClock;
  ids?: TaskFlowIds;
}

export interface TaskManagerPort {
  prepareSessionDeletion(sessionId: string): Promise<boolean>;
  createTask(input: CreateTaskInput): Promise<CreateTaskWithUserMessageResult>;
  cancelTask(taskId: string, expectedVersion: number): Promise<AgentTask>;
  answerUserInputRequest(input: Omit<AnswerUserInputRequestInput, 'answerMessageId'>): Promise<SaveUserInputAnswerResult>;
}

/** Public command facade. Each lifecycle branch has a concrete Flow class. */
export class TaskManager implements TaskManagerPort {
  readonly #clock: TaskFlowClock;
  readonly #events: TaskEventPublisher;
  readonly #create: CreateTaskFlow;
  readonly #cancel: CancelTaskFlow;
  readonly #answerUserInput: AnswerUserInputFlow;

  constructor(private readonly options: TaskManagerOptions) {
    const clock = options.clock ?? { nowMs: () => Date.now() };
    this.#clock = clock;
    const ids = options.ids ?? randomTaskFlowIds;
    const events = new TaskEventPublisher(options.publisher);
    this.#events = events;
    const taskRuns = new TaskRunStarter(
      options.store,
      options.workerId,
      options.ownershipTimeoutMs,
      clock,
      ids.taskRunId,
      events
    );
    const dispatcher = new TaskExecutionDispatcher(options.execution);
    this.#create = new CreateTaskFlow(options.store, clock, ids.taskId, ids.messageId, taskRuns, events, dispatcher);
    this.#cancel = new CancelTaskFlow(options.store, clock, events, options.execution);
    this.#answerUserInput = new AnswerUserInputFlow(
      options.store,
      options.workerId,
      options.ownershipTimeoutMs,
      clock,
      ids.messageId,
      ids.taskRunId,
      events,
      dispatcher
    );
  }

  async prepareSessionDeletion(sessionId: string): Promise<boolean> {
    try {
      const fenced = await this.options.store.sessions.beginDeletion({
        sessionId,
        nowMs: this.#clock.nowMs(),
      });
      const stopping = this.options.execution.abortSessionExecutions(sessionId);
      await Promise.all([
        stopping,
        ...fenced.taskFinishes.map(result => this.#events.publishTaskFinish(result)),
      ]);
      return fenced.existed;
    } catch (error) {
      throw mapStoreError(error);
    }
  }
  createTask(input: CreateTaskInput) { return this.#create.execute(input); }
  cancelTask(taskId: string, expectedVersion: number) { return this.#cancel.execute(taskId, expectedVersion); }
  answerUserInputRequest(input: Omit<AnswerUserInputRequestInput, 'answerMessageId'>) {
    return this.#answerUserInput.execute(input);
  }
}

export type { AnswerUserInputRequestInput, CreateTaskInput };
