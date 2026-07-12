import type { AgentJob, AgentRealtimeEvent } from '../../domain/index.js';
import { DirectJobContextLoader } from '../loaders/direct-job-context-loader.js';
import type { RuntimeEventPublisher } from '../runtime-event-writer.js';
import { ReactExecutor } from './react-executor.js';

export class DirectJobExecutor {
  constructor(
    private readonly react: ReactExecutor,
    private readonly contexts: DirectJobContextLoader,
    private readonly publisher: RuntimeEventPublisher
  ) {}

  async execute(job: AgentJob, originalGoal: string): Promise<void> {
    const result = await this.react.runDirect({
      job,
      loadContext: () => this.contexts.load(job, originalGoal),
    });
    if (result.type === 'failed' || result.type === 'cancelled') {
      await this.#safePublish({
        type: 'job.upserted',
        sessionId: result.job.sessionId,
        job: result.job,
      });
    }
  }

  async #safePublish(event: AgentRealtimeEvent): Promise<void> {
    try {
      await this.publisher.publish(event);
    } catch {
      // The durable SessionView remains authoritative when realtime delivery fails.
    }
  }
}
