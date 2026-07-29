import { randomUUID } from 'node:crypto';
import { mapStoreError, RuntimeError } from '../../../runtime/errors/runtime-error.js';
import type { RuntimeEventPublisher } from '../../../runtime/events/runtime-event-writer.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import type { ExecuteTaskRunCommand } from '../task-executor.js';

export interface InterruptedTaskScannerOptions {
  store: AgentStore;
  publisher: RuntimeEventPublisher;
  createdTaskGraceMs: number;
  batchSize: number;
  clock: { nowMs(): number };
  ownerId: string;
  ownershipTimeoutMs: number;
  onTaskReady(command: ExecuteTaskRunCommand): void;
}

/** Runs startup reconciliation in bounded batches and never schedules itself. */
export class InterruptedTaskScanner {
  constructor(private readonly options: InterruptedTaskScannerOptions) {}

  async scanOnce(): Promise<void> {
    const nowMs = this.options.clock.nowMs();
    await this.options.store.models.abandonStartedCalls(nowMs);
    while (await this.#expireUserInputBatch(nowMs)) {
      // Drain the startup backlog in bounded database batches.
    }
    while (await this.#recoverTaskBatch(nowMs)) {
      // Drain the startup backlog in bounded database batches.
    }
  }

  async #recoverTaskBatch(nowMs: number): Promise<boolean> {
    const candidates = await this.options.store.tasks.listNeedingRecovery({
      nowMs,
      createdBeforeMs: nowMs - this.options.createdTaskGraceMs,
      limit: this.options.batchSize,
    });
    let recovered = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.options.store.tasks.markRecoveryRequired({
          taskId: candidate.task.id,
          expectedTaskVersion: candidate.task.version,
          nowMs: this.options.clock.nowMs(),
        });
        const events = [
          { type: 'task.upserted' as const, sessionId: result.task.sessionId, task: result.task },
          ...(result.taskRun ? [{
            type: 'task_run.upserted' as const,
            sessionId: result.task.sessionId,
            taskRun: result.taskRun,
          }] : []),
          ...result.toolCalls.map(toolCall => ({
            type: 'tool_call.upserted' as const,
            sessionId: result.task.sessionId,
            toolCall,
          })),
          ...result.toolRuns.map(toolRun => ({
            type: 'tool_run.upserted' as const,
            sessionId: result.task.sessionId,
            toolRun,
          })),
        ];
        for (const event of events) await this.#publish(event);
        recovered += 1;
      } catch (error) {
        const mapped = mapStoreError(error);
        if (!(mapped instanceof RuntimeError
          && ['concurrency_conflict', 'invalid_task_state', 'ownership_lost'].includes(mapped.code))) {
          throw mapped;
        }
      }
    }
    return candidates.length === this.options.batchSize && recovered > 0;
  }

  async #expireUserInputBatch(nowMs: number): Promise<boolean> {
    const requests = await this.options.store.execution.listExpiredUserInputRequests(
      nowMs,
      this.options.batchSize
    );
    let expired = 0;
    for (const request of requests) {
      try {
        const result = await this.options.store.execution.expireUserInput({
          requestId: request.id,
          expectedVersion: request.version,
          resultMessageId: `message_${randomUUID()}`,
          taskRunId: `task_run_${randomUUID()}`,
          ownerId: this.options.ownerId,
          nowMs: this.options.clock.nowMs(),
          ownershipExpiresAtMs:
            this.options.clock.nowMs() + this.options.ownershipTimeoutMs,
        });
        await this.#publish({
          type: 'message.upserted',
          sessionId: result.task.sessionId,
          message: result.resultMessage,
        });
        await this.#publish({
          type: 'tool_call.upserted',
          sessionId: result.task.sessionId,
          toolCall: result.toolCall,
        });
        await this.#publish({
          type: 'user_input.upserted',
          sessionId: result.task.sessionId,
          request: result.request,
        });
        await this.#publish({
          type: 'task.upserted',
          sessionId: result.task.sessionId,
          task: result.task,
        });
        if (result.taskRun) {
          await this.#publish({
            type: 'task_run.upserted',
            sessionId: result.task.sessionId,
            taskRun: result.taskRun,
          });
        }
        if (result.shouldResume) {
          if (!result.taskRun) {
            throw new RuntimeError(
              'storage_error',
              'Input expiration committed a resumed Task without a TaskRun.'
            );
          }
          this.options.onTaskReady({
            taskId: result.task.id,
            taskRunId: result.taskRun.id,
          });
        }
        expired += 1;
      } catch (error) {
        const mapped = mapStoreError(error);
        if (!(mapped instanceof RuntimeError
          && ['concurrency_conflict', 'invalid_task_state'].includes(mapped.code))) {
          throw mapped;
        }
      }
    }
    return requests.length === this.options.batchSize && expired > 0;
  }

  async #publish(event: Parameters<RuntimeEventPublisher['publish']>[0]): Promise<void> {
    try {
      await this.options.publisher.publish(event);
    } catch {
      // SessionView remains authoritative.
    }
  }
}
