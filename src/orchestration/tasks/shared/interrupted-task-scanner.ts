import { randomUUID } from 'node:crypto';
import { mapStoreError, RuntimeError } from '../../../runtime/errors/runtime-error.js';
import type { RuntimeEventPublisher } from '../../../runtime/events/runtime-event-publisher.js';
import { taskFinishEvents } from '../../../runtime/events/helpers/task-finish-events.js';
import { createSideEffectConfirmationRequest } from '../../../runtime/hitl/side-effect-confirmation.js';
import type { AgentStore } from '../../../storage/agent-store.js';

export interface InterruptedTaskScannerOptions {
  store: AgentStore;
  publisher: RuntimeEventPublisher;
  createdTaskGraceMs: number;
  batchSize: number;
  clock: { nowMs(): number };
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
    while (await this.#reconcileTaskBatch(nowMs)) {
      // Drain the startup backlog in bounded database batches.
    }
  }

  async #reconcileTaskBatch(nowMs: number): Promise<boolean> {
    const candidates = await this.options.store.tasks.listInterrupted({
      nowMs,
      createdBeforeMs: nowMs - this.options.createdTaskGraceMs,
      limit: this.options.batchSize,
    });
    let reconciled = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.options.store.tasks.reconcileInterrupted({
          taskId: candidate.task.id,
          expectedTaskVersion: candidate.task.version,
          confirmationRequests: candidate.sideEffectingToolCalls.map(toolCall => ({
            toolCallId: toolCall.id,
            ...createSideEffectConfirmationRequest({
              requestId: `input_${randomUUID()}`,
              toolName: toolCall.toolName,
              reason: 'service_restart',
            }),
          })),
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
          ...result.userInputRequests.map(request => ({
            type: 'user_input.upserted' as const,
            sessionId: result.task.sessionId,
            request,
          })),
          ...(result.planCleared ? [{
            type: 'plan.cleared' as const,
            sessionId: result.task.sessionId,
            taskId: result.task.id,
          }] : []),
        ];
        for (const event of events) await this.#publish(event);
        reconciled += 1;
      } catch (error) {
        const mapped = mapStoreError(error);
        if (!(mapped instanceof RuntimeError
          && ['concurrency_conflict', 'invalid_task_state', 'ownership_lost'].includes(mapped.code))) {
          throw mapped;
        }
      }
    }
    return candidates.length === this.options.batchSize && reconciled > 0;
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
          nowMs: this.options.clock.nowMs(),
        });
        await this.#publish({
          type: 'message.upserted',
          sessionId: result.task.sessionId,
          message: result.resultMessage,
        });
        for (const event of taskFinishEvents(result)) await this.#publish(event);
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
