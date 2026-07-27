import type {
  AgentJob,
  AgentRealtimeEvent,
} from '../../../domain/index.js';
import type { RuntimeEventPublisher } from '../../../runtime/events/runtime-event-writer.js';

/** Best-effort realtime projection of already committed Job state. */
export class JobEventPublisher {
  constructor(private readonly publisher: RuntimeEventPublisher) {}

  publishJob(job: AgentJob): Promise<void> {
    return this.publish({ type: 'job.upserted', sessionId: job.sessionId, job });
  }

  async publishAll(events: AgentRealtimeEvent[]): Promise<void> {
    for (const event of events) await this.publish(event);
  }

  async publish(event: AgentRealtimeEvent): Promise<void> {
    try {
      await this.publisher.publish(event);
    } catch {
      // Durable SessionView reconstruction is authoritative after publish loss.
    }
  }
}
