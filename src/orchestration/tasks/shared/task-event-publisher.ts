import type { AgentRealtimeEvent, AgentTask } from '../../../domain/index.js';
import type { RuntimeEventPublisher } from '../../../runtime/events/runtime-event-publisher.js';
import { taskFinishEvents } from '../../../runtime/events/helpers/task-finish-events.js';
import type { FinishTaskResult } from '../../../storage/agent-store.js';

/** Best-effort projection of state that is already committed in PostgreSQL. */
export class TaskEventPublisher {
  constructor(private readonly publisher: RuntimeEventPublisher) {}

  publishTask(task: AgentTask): Promise<void> {
    return this.publish({ type: 'task.upserted', sessionId: task.sessionId, task });
  }

  publishTaskFinish(result: FinishTaskResult): Promise<void> {
    return this.publishAll(taskFinishEvents(result));
  }

  async publishAll(events: AgentRealtimeEvent[]): Promise<void> {
    for (const event of events) await this.publish(event);
  }

  async publish(event: AgentRealtimeEvent): Promise<void> {
    try {
      await this.publisher.publish(event);
    } catch {
      // Refresh reconstructs the authoritative SessionView from PostgreSQL.
    }
  }
}
