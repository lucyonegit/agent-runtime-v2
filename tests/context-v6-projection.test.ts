import { describe, expect, it } from 'vitest';
import type {
  AgentJob,
  AgentMessage,
  AgentPlan,
  AgentPlanStep,
  AgentStepRun,
} from '../src/domain/index.js';
import { MessageGroupBuilder } from '../src/runtime/context/message-group-builder.js';

describe('v6 semantic context projection', () => {
  it('projects immutable plan, structured step output and a legacy plan final', () => {
    const output = {
      schemaVersion: 1 as const,
      summary: 'validated',
      artifacts: [], evidence: [], unresolved: [],
    };
    const plan = planFixture();
    const step = stepFixture();
    const run = runFixture();
    const built = new MessageGroupBuilder().build([
      message({ id: 'goal', rowId: 1, role: 'user', messageType: 'user_message' }),
      message({
        id: 'plan_created', rowId: 2, role: 'assistant', messageType: 'plan_created',
        planId: plan.id,
      }),
      message({
        id: 'step_output', rowId: 3, role: 'assistant', messageType: 'step_output',
        planId: plan.id, stepId: step.id, stepRunId: run.id,
        metadata: { structuredOutput: output },
      }),
      message({
        id: 'plan_final', rowId: 4, role: 'assistant', messageType: 'plan_final',
        planId: undefined,
      }),
    ], [], {
      jobs: [jobFixture()], plans: [plan], steps: [step], stepRuns: [run],
    });

    expect(built.groups.map(group => group.type)).toEqual([
      'single', 'plan_definition', 'step_output', 'plan_final',
    ]);
    const definition = built.groups[1];
    expect(definition?.type).toBe('plan_definition');
    if (definition?.type === 'plan_definition') {
      expect(definition.steps.map(item => item.id)).toEqual(['step_1']);
    }
    const final = built.groups[3];
    expect(final?.type).toBe('plan_final');
    if (final?.type === 'plan_final') expect(final.plan.id).toBe('plan_1');
  });
});

function jobFixture(): AgentJob {
  return {
    id: 'job_1', sessionId: 'session_1', strategy: 'planned', stage: 'finalizing',
    status: 'completed', attemptNo: 1, version: 1, createdAtMs: 1, updatedAtMs: 4,
  };
}

function planFixture(): AgentPlan {
  return {
    id: 'plan_1', sessionId: 'session_1', jobId: 'job_1', title: 'Plan', goal: 'Goal',
    status: 'completed', version: 3, createdAtMs: 2, updatedAtMs: 4,
  };
}

function stepFixture(): AgentPlanStep {
  return {
    id: 'step_1', planId: 'plan_1', position: 0, title: 'Step', instruction: 'Do it',
    status: 'completed', outputMessageId: 'step_output', version: 2,
    createdAtMs: 2, updatedAtMs: 3,
  };
}

function runFixture(): AgentStepRun {
  return {
    id: 'run_1', sessionId: 'session_1', jobId: 'job_1', planId: 'plan_1', stepId: 'step_1',
    runNo: 1, status: 'completed', attemptNo: 1, outputMessageId: 'step_output', version: 2,
    createdAtMs: 2, updatedAtMs: 3,
  };
}

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'rowId'>): AgentMessage {
  return {
    sessionId: 'session_1', jobId: 'job_1', role: 'assistant',
    messageType: 'assistant_message', visibility: 'ui', channel: 'normal',
    content: overrides.id, createdAtMs: overrides.rowId, ...overrides,
  };
}
