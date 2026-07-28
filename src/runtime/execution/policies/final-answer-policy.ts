import type { AgentStore } from '../../../storage/agent-store.js';
import { mapStoreError } from '../../errors/runtime-error.js';

export class FinalAnswerPolicy {
  constructor(private readonly store: AgentStore) {}

  async validate(jobId: string) {
    try {
      const plan = await this.store.plans.getByJobId(jobId);
      if (!plan || plan.status === 'completed') return { type: 'accept' as const };
      const steps = await this.store.plans.listSteps(plan.id);
      if (plan.status === 'failed' || plan.status === 'cancelled') {
        return {
          type: 'fail' as const,
          code: 'invalid_plan_state' as const,
          message: `Plan ${JSON.stringify(plan.id)} is ${plan.status} and cannot produce a successful final answer.`,
          details: { planId: plan.id, planStatus: plan.status },
        };
      }
      const snapshot = steps.map(step => ({
        key: step.key,
        title: step.title,
        status: step.status,
        result: step.result,
      }));
      return {
        type: 'retry' as const,
        code: 'final.plan_incomplete',
        feedback: [
          'Runtime validation rejected the previous answer because the durable plan is still active.',
          'Do not answer the user yet. Call update_plan alone with the complete plan.',
          'Mark completed work completed with result summaries; mark unnecessary work skipped.',
          'Only after update_plan returns a terminal completed plan may you provide the final answer.',
          `Current plan id=${plan.id}, version=${plan.version}, steps=${JSON.stringify(snapshot)}`,
        ].join('\n'),
      };
    } catch (error) {
      throw mapStoreError(error);
    }
  }
}
