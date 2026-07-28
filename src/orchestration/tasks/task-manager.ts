import type { AgentTask } from '../../domain/index.js';
import type {
  AgentStore,
  CreateRetryTaskResult,
  CreateTaskWithUserMessageResult,
  SaveUserInputAnswerResult,
} from '../../storage/agent-store.js';
import type { RuntimeEventPublisher } from '../../runtime/events/runtime-event-writer.js';
import { AnswerUserInputFlow, type AnswerUserInputRequestInput } from './flows/answer-user-input.flow.js';
import { CancelTaskFlow } from './flows/cancel-task.flow.js';
import { ContinueAsNewTaskFlow, type ContinueAsNewTaskInput } from './flows/continue-as-new-task.flow.js';
import { CreateTaskFlow, type CreateTaskInput } from './flows/create-task.flow.js';
import { ResumeTaskFlow } from './flows/resume-task.flow.js';
import { RetryTaskFlow, type RetryTaskInput } from './flows/retry-task.flow.js';
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
  start(): Promise<void>;
  shutdown(): Promise<void>;
  createTask(input: CreateTaskInput): Promise<CreateTaskWithUserMessageResult>;
  cancelTask(taskId: string, expectedVersion: number): Promise<AgentTask>;
  retryTask(input: RetryTaskInput): Promise<CreateRetryTaskResult>;
  continueAsNewTask(input: ContinueAsNewTaskInput): Promise<CreateTaskWithUserMessageResult>;
  resumeTask(taskId: string, expectedVersion: number): Promise<AgentTask>;
  answerUserInputRequest(input: Omit<AnswerUserInputRequestInput, 'answerMessageId'>): Promise<SaveUserInputAnswerResult>;
}

/** Public command facade. Each lifecycle branch has a concrete Flow class. */
export class TaskManager implements TaskManagerPort {
  readonly #create: CreateTaskFlow;
  readonly #retry: RetryTaskFlow;
  readonly #continueAsNew: ContinueAsNewTaskFlow;
  readonly #resume: ResumeTaskFlow;
  readonly #cancel: CancelTaskFlow;
  readonly #answerUserInput: AnswerUserInputFlow;

  constructor(private readonly options: TaskManagerOptions) {
    const clock = options.clock ?? { nowMs: () => Date.now() };
    const ids = options.ids ?? randomTaskFlowIds;
    const events = new TaskEventPublisher(options.publisher);
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
    this.#retry = new RetryTaskFlow(options.store, clock, ids.taskId, taskRuns, events, dispatcher);
    this.#continueAsNew = new ContinueAsNewTaskFlow(
      options.store, clock, ids.taskId, ids.messageId, taskRuns, events, dispatcher
    );
    this.#resume = new ResumeTaskFlow(options.store, options.workerId, clock, taskRuns, events, dispatcher);
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

  start(): Promise<void> { return this.options.execution.start(); }
  shutdown(): Promise<void> { return this.options.execution.shutdown(); }
  createTask(input: CreateTaskInput) { return this.#create.execute(input); }
  retryTask(input: RetryTaskInput) { return this.#retry.execute(input); }
  continueAsNewTask(input: ContinueAsNewTaskInput) { return this.#continueAsNew.execute(input); }
  resumeTask(taskId: string, expectedVersion: number) { return this.#resume.execute(taskId, expectedVersion); }
  cancelTask(taskId: string, expectedVersion: number) { return this.#cancel.execute(taskId, expectedVersion); }
  answerUserInputRequest(input: Omit<AnswerUserInputRequestInput, 'answerMessageId'>) {
    return this.#answerUserInput.execute(input);
  }
}

export type { AnswerUserInputRequestInput, ContinueAsNewTaskInput, CreateTaskInput, RetryTaskInput };
