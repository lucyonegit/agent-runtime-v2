import type { AgentRealtimeEvent } from '../../domain/index.js';

/** Publishes runtime events to external realtime observers. */
export interface RuntimeEventPublisher {
  publish(event: AgentRealtimeEvent): void | Promise<void>;
}
