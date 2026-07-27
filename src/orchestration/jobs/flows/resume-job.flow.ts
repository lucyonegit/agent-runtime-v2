import type { AgentJob } from '../../../domain/index.js';
import type { AgentStore } from '../../../storage/agent-store.js';
import { JobAttemptStarter } from '../shared/job-attempt-starter.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import { JobStateTransitions } from '../shared/job-state-transitions.js';

export class ResumeJobFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly state: JobStateTransitions,
    private readonly attempts: JobAttemptStarter,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher,
    private readonly clock: { nowMs(): number }
  ) {}

  async execute(jobId: string, expectedVersion: number): Promise<AgentJob> {
    const recoveryJob = await this.state.requireRecoveryJob(jobId, expectedVersion);
    const running = await this.attempts.start(recoveryJob);
    const prepared = await this.store.prepareToolInvocationsForRecovery({
      jobId: running.id,
      workerId: running.leaseOwner!,
      attemptId: running.currentAttemptId!,
      nowMs: this.clock.nowMs(),
    });
    await this.events.publishAll([
      ...prepared.invocations,
      ...prepared.blockedInvocations,
    ].map(invocation => ({
      type: 'tool_invocation.upserted' as const,
      sessionId: running.sessionId,
      invocation,
    })));

    if (prepared.blockedInvocations.length > 0) {
      const failed = await this.state.fail(running, {
        code: 'unsafe_tool_recovery',
        message: 'A side-effecting tool was interrupted after it started. Its outcome must be reconciled before retrying.',
        details: prepared.blockedInvocations.map(invocation => ({
          invocationId: invocation.id,
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          status: invocation.status,
          sideEffectLevel: invocation.sideEffectLevel,
        })),
      });
      await this.events.publishJob(failed);
      return failed;
    }

    this.execution.dispatch(running.id);
    return running;
  }
}
