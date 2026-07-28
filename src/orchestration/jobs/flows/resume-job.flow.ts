import type { AgentJob } from '../../../domain/index.js';
import type {
  AgentStore,
  PrepareToolInvocationsForRecoveryResult,
} from '../../../storage/agent-store.js';
import { mapStoreError, RuntimeError } from '../../../runtime/errors/runtime-error.js';
import { JobAttemptStarter } from '../shared/job-attempt-starter.js';
import { JobEventPublisher } from '../shared/job-event-publisher.js';
import { JobExecutionDispatcher } from '../shared/job-execution-dispatcher.js';
import type { JobFlowClock } from '../shared/job-flow.helper.js';

export class ResumeJobFlow {
  constructor(
    private readonly store: AgentStore,
    private readonly workerId: string,
    private readonly clock: JobFlowClock,
    private readonly attempts: JobAttemptStarter,
    private readonly events: JobEventPublisher,
    private readonly execution: JobExecutionDispatcher
  ) {}

  async execute(jobId: string, expectedVersion: number): Promise<AgentJob> {
    let recoveryJob: AgentJob | undefined;
    try {
      recoveryJob = await this.store.jobs.get(jobId);
    } catch (error) {
      throw mapStoreError(error);
    }
    if (!recoveryJob
      || recoveryJob.status !== 'recovery_required'
      || recoveryJob.version !== expectedVersion) {
      throw new RuntimeError(
        'invalid_job_state',
        `Job ${JSON.stringify(jobId)} must require recovery at version ${expectedVersion}.`,
        {
          details: {
            jobId,
            expectedVersion,
            version: recoveryJob?.version,
            status: recoveryJob?.status,
          },
        }
      );
    }
    const running = await this.attempts.start(recoveryJob);
    if (!running.currentAttemptId || running.leaseOwner !== this.workerId) {
      throw new RuntimeError(
        'lease_lost',
        `Job ${JSON.stringify(running.id)} is not owned by this Job executor.`,
        { details: { jobId: running.id, workerId: this.workerId } }
      );
    }
    let prepared: PrepareToolInvocationsForRecoveryResult;
    try {
      prepared = await this.store.execution.prepareToolsForRecovery({
        jobId: running.id,
        workerId: this.workerId,
        attemptId: running.currentAttemptId,
        nowMs: this.clock.nowMs(),
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    await this.events.publishAll([
      ...prepared.invocations,
      ...prepared.blockedInvocations,
    ].map(invocation => ({
      type: 'tool_invocation.upserted' as const,
      sessionId: running.sessionId,
      invocation,
    })));

    if (prepared.blockedInvocations.length > 0) {
      let failed: AgentJob;
      try {
        failed = await this.store.jobs.fail({
          jobId: running.id,
          expectedVersion: running.version,
          workerId: this.workerId,
          attemptId: running.currentAttemptId,
          error: {
            code: 'unsafe_tool_recovery',
            message: 'A side-effecting tool was interrupted after it started. Its outcome must be reconciled before retrying.',
            details: prepared.blockedInvocations.map(invocation => ({
              invocationId: invocation.id,
              toolCallId: invocation.toolCallId,
              toolName: invocation.toolName,
              status: invocation.status,
              sideEffectLevel: invocation.sideEffectLevel,
            })),
          },
          nowMs: this.clock.nowMs(),
        });
      } catch (error) {
        throw mapStoreError(error);
      }
      await this.events.publishJob(failed);
      return failed;
    }

    this.execution.dispatch(running.id);
    return running;
  }
}
