import { RuntimeError } from '../../../runtime/errors/runtime-error.js';
import type { RuntimeEventPublisher } from '../../../runtime/events/runtime-event-writer.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import type { JobStateTransitions } from './job-state-transitions.js';

export interface InterruptedJobScannerOptions {
  store: AgentStore;
  jobState: JobStateTransitions;
  publisher: RuntimeEventPublisher;
  scanIntervalMs: number;
  batchSize: number;
  clock: { nowMs(): number };
}

/** Detects abandoned runtime work and exposes it as explicitly resumable state. */
export class InterruptedJobScanner {
  readonly #options: InterruptedJobScannerOptions;
  #timer?: ReturnType<typeof setInterval>;
  #activeScan?: Promise<void>;
  #started = false;
  #stopping = false;

  constructor(options: InterruptedJobScannerOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    try {
      await this.#scan();
      if (this.#stopping) return;
      this.#timer = setInterval(() => {
        void this.#scan().catch(() => {
          // The next scan retries transient storage failures.
        });
      }, this.#options.scanIntervalMs);
      this.#timer.unref();
    } catch (error) {
      this.#started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#activeScan?.catch(() => undefined);
  }

  #scan(): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    if (this.#activeScan) return this.#activeScan;

    let scan!: Promise<void>;
    scan = this.#processBatch().finally(() => {
      if (this.#activeScan === scan) this.#activeScan = undefined;
    });
    this.#activeScan = scan;
    return scan;
  }

  async #processBatch(): Promise<void> {
    const nowMs = this.#options.clock.nowMs();
    await this.#options.store.abandonStartedModelCalls(nowMs);
    const jobs = await this.#options.store.listJobsNeedingRuntimeRecovery({
      nowMs,
      createdBeforeMs: nowMs - this.#options.scanIntervalMs,
      limit: this.#options.batchSize,
    });
    for (const job of jobs) {
      if (this.#stopping) break;
      try {
        const recoveryRequiredJob = await this.#options.jobState.markRecoveryRequired(
          job.id,
          job.version
        );
        await this.#publishWithoutFailingScan({
          type: 'job.upserted',
          sessionId: recoveryRequiredJob.sessionId,
          job: recoveryRequiredJob,
        });
      } catch (error) {
        if (!(error instanceof RuntimeError
          && ['concurrency_conflict', 'invalid_job_state', 'lease_lost'].includes(error.code))) {
          throw error;
        }
      }
    }
  }

  async #publishWithoutFailingScan(
    event: Parameters<RuntimeEventPublisher['publish']>[0]
  ): Promise<void> {
    try {
      await this.#options.publisher.publish(event);
    } catch {
      // SessionView is authoritative when realtime delivery fails.
    }
  }
}
