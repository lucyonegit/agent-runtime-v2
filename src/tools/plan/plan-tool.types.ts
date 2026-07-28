import type { RuntimeEventPublisher } from '../../runtime/events/runtime-event-writer.js';
import type { AgentStore } from '../../storage/agent-store.js';

export interface CreatePlanToolsOptions {
  store: AgentStore;
  workerId: string;
  publisher: RuntimeEventPublisher;
  clock?: { nowMs(): number };
}
