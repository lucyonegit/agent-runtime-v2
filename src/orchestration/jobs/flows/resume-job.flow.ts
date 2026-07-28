import type { AgentJob } from '../../../domain/index.js';
import { JobAttemptStarter } from '../shared/job-attempt-starter.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import { JobStore } from '../shared/job-store.js';

export class ResumeJobFlow {
  constructor(
    private readonly jobStore: JobStore,
    private readonly attempts: JobAttemptStarter,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher
  ) {}

  async execute(jobId: string, expectedVersion: number): Promise<AgentJob> {
    const recoveryJob = await this.jobStore.requireRecoveryJob(jobId, expectedVersion);
    const running = await this.attempts.start(recoveryJob);
    const prepared = await this.jobStore.prepareToolInvocationsForRecovery(running);
    await this.events.publishAll([
      ...prepared.invocations,
      ...prepared.blockedInvocations,
    ].map(invocation => ({
      type: 'tool_invocation.upserted' as const,
      sessionId: running.sessionId,
      invocation,
    })));

    if (prepared.blockedInvocations.length > 0) {
      const failed = await this.jobStore.fail(running, {
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
