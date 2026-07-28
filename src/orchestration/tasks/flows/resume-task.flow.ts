import type { AgentTask } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import { mapStoreError, RuntimeError } from '../../../runtime/errors/runtime-error.js';
import { TaskRunStarter } from '../shared/task-run-starter.js';
import { TaskEventPublisher } from '../shared/task-event-publisher.js';
import { TaskExecutionDispatcher } from '../shared/task-execution-dispatcher.js';
import type { TaskFlowClock } from '../shared/task-flow.helper.js';

export class ResumeTaskFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly ownerId: string,
    private readonly clock: TaskFlowClock,
    private readonly taskRuns: TaskRunStarter,
    private readonly events: TaskEventPublisher,
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
    try {
      const prepared = await this.store.execution.prepareToolCallsForResume({
        taskId: started.task.id,
        taskRunId: started.taskRun.id,
        ownerId: this.ownerId,
        nowMs: this.clock.nowMs(),
      });
      await this.events.publishAll([
        ...prepared.toolCalls,
        ...prepared.blockedToolCalls,
      ].map(toolCall => ({
        type: 'tool_call.upserted' as const,
        sessionId: started.task.sessionId,
        toolCall,
      })));

      if (prepared.blockedToolCalls.length > 0) {
        const failed = await this.store.tasks.fail({
          taskId: started.task.id,
          expectedTaskVersion: started.task.version,
          taskRunId: started.taskRun.id,
          ownerId: this.ownerId,
          error: {
            code: 'unsafe_tool_recovery',
            message: 'A side-effecting tool has an unknown outcome and cannot be replayed automatically.',
            details: prepared.blockedToolCalls.map(toolCall => ({
              toolCallId: toolCall.id,
              modelToolCallId: toolCall.modelToolCallId,
              toolName: toolCall.toolName,
              status: toolCall.status,
            })),
          },
          nowMs: this.clock.nowMs(),
        });
        await this.events.publishTaskFinish(failed);
        return failed.task;
      }

      this.execution.dispatch(started.task.id);
      return started.task;
    } catch (error) {
      throw mapStoreError(error);
    }
  }
}
