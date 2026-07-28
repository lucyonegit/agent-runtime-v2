import { randomUUID } from 'node:crypto';
import { mapStoreError, RuntimeError } from '../../../runtime/errors/runtime-error.js';
import type { RuntimeEventPublisher } from '../../../runtime/events/runtime-event-writer.js';
import type { AgentStore } from '../../../storage/agent-store.js';

export interface InterruptedTaskScannerOptions {
  store: AgentStore;
  publisher: RuntimeEventPublisher;
  scanIntervalMs: number;
  batchSize: number;
  clock: { nowMs(): number };
  ownerId: string;
  ownershipTimeoutMs: number;
  onTaskReady(taskId: string): void;
}

/** Marks abandoned work as recovery_required. It never auto-resumes execution. */
export class InterruptedTaskScanner {
  #timer?: ReturnType<typeof setInterval>;
  #activeScan?: Promise<void>;
  #stopping = false;

  constructor(private readonly options: InterruptedTaskScannerOptions) {}

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#scan();
    if (this.#stopping || this.#timer) return;
    this.#timer = setInterval(() => {
      void this.#scan().catch(() => undefined);
    }, this.options.scanIntervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#activeScan?.catch(() => undefined);
  }

  #scan(): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    if (this.#activeScan) return this.#activeScan;
    const scan = this.#processBatch().finally(() => {
      if (this.#activeScan === scan) this.#activeScan = undefined;
    });
    this.#activeScan = scan;
    return scan;
  }

  async #processBatch(): Promise<void> {
    const nowMs = this.options.clock.nowMs();
    await this.options.store.models.abandonStartedCalls(nowMs);
    await this.#expireUserInputRequests(nowMs);
    const candidates = await this.options.store.tasks.listNeedingRecovery({
      nowMs,
      createdBeforeMs: nowMs - this.options.scanIntervalMs,
      limit: this.options.batchSize,
    });
    for (const candidate of candidates) {
      if (this.#stopping) break;
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
      } catch (error) {
        const mapped = mapStoreError(error);
        if (!(mapped instanceof RuntimeError
          && ['concurrency_conflict', 'invalid_task_state', 'ownership_lost'].includes(mapped.code))) {
          throw mapped;
        }
      }
    }
  }

  async #expireUserInputRequests(nowMs: number): Promise<void> {
    const requests = await this.options.store.execution.listExpiredUserInputRequests(
      nowMs,
      this.options.batchSize
    );
    for (const request of requests) {
      if (this.#stopping) break;
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
        if (result.shouldResume) this.options.onTaskReady(result.task.id);
      } catch (error) {
        const mapped = mapStoreError(error);
        if (!(mapped instanceof RuntimeError
          && ['concurrency_conflict', 'invalid_task_state'].includes(mapped.code))) {
          throw mapped;
        }
      }
    }
  }

  async #publish(event: Parameters<RuntimeEventPublisher['publish']>[0]): Promise<void> {
    try {
      await this.options.publisher.publish(event);
    } catch {
      // SessionView remains authoritative.
    }
  }
}
