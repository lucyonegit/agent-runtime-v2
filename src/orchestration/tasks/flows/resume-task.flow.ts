import type { AgentTask } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import { RuntimeError } from '../../../runtime/errors/runtime-error.js';
import { TaskRunStarter } from '../shared/task-run-starter.js';
import { TaskExecutionDispatcher } from '../shared/task-execution-dispatcher.js';

export class ResumeTaskFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly taskRuns: TaskRunStarter,
    private readonly execution: TaskExecutionDispatcher
  ) {}

  async execute(taskId: string, expectedVersion: number): Promise<AgentTask> {
    const task = await this.store.tasks.get(taskId);
    if (!task || task.status !== 'recovery_required' || task.version !== expectedVersion) {
      throw new RuntimeError(
        'invalid_task_state',
        `Task ${JSON.stringify(taskId)} must require recovery at version ${expectedVersion}.`,
        { details: { taskId, expectedVersion, version: task?.version, status: task?.status } }
      );
    }

    const started = await this.taskRuns.start(task, 'manual_resume');
    this.execution.dispatch({ taskId: started.task.id, taskRunId: started.taskRun.id });
    return started.task;
  }
}
