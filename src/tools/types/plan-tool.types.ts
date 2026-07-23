import type { RuntimeEventPublisher } from '../../runtime/runtime-event-writer.js';
import type { AgentStore } from '../../storage/agent-store.js';

export interface CreatePlanToolsOptions {
  store: AgentStore;
  workerId: string;
  publisher: RuntimeEventPublisher;
  clock?: { nowMs(): number };
  ids?: { planId(): string; planStepId(): string };
}
