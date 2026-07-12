import type { AgentJob, AgentRealtimeEvent } from '../../domain/index.js';
import type { ExecutionContextProviderPort } from '../execution/execution-context-provider.js';
import type { RuntimeEventPublisher } from '../../runtime/runtime-event-writer.js';
import { ReactExecutionRuntime } from '../../runtime/react-execution-runtime.js';

export class DirectJobWorkflow {
  constructor(
    private readonly react: ReactExecutionRuntime,
    private readonly contexts: ExecutionContextProviderPort,
    private readonly publisher: RuntimeEventPublisher
  ) {}

  async execute(job: AgentJob, originalGoal: string): Promise<void> {
    const context = await this.contexts.buildDirectContext(job, originalGoal);
    const result = await this.react.runDirect({ job, context });
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
