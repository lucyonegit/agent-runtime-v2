import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  AgentJob,
  AgentMessage,
  AgentModelCall,
  AgentPlan,
  AgentPlanStep,
  AgentSession,
  AgentStepRun,
} from '../src/domain/index.js';
import {
  ContextInspectionService,
  type ContextInspectionStore,
} from '../src/orchestration/context-inspection.service.js';

describe('ContextInspectionService', () => {
  it('routes next_turn, job and exact model_call through shared loaders', async () => {
    const messages = [message({ id: 'goal_1', rowId: 1, content: 'hello' })];
    const jobs = [job({ metadata: { goalMessageId: 'goal_1' } })];
    let modelCall: AgentModelCall | undefined;
    const service = inspection(store({ messages, jobs, getModelCall: () => modelCall }));

    const nextTurn = await service.inspect({ kind: 'next_turn', sessionId: 'session_1' });
    expect(nextTurn.built.messages.map(item => item.content)).toEqual(['system', 'hello']);

    const jobSnapshot = await service.inspect({ kind: 'job', jobId: 'job_1' });
    const serialized = JSON.stringify(jobSnapshot.built.messages.map(item => item.toDict()));
    modelCall = modelCallFixture({
      inputChecksum: createHash('sha256').update(serialized).digest('hex'),
      inputManifest: jobSnapshot.built.inputManifest,
    });
    messages.push(message({
      id: 'later_message', rowId: 2, role: 'assistant',
      messageType: 'assistant_message', content: 'added after the inspected call',
    }));
    jobs[0] = { ...jobs[0]!, strategy: 'planned', stage: 'step_execution' };
    const exact = await service.inspect({ kind: 'model_call', modelCallId: modelCall.id });
    expect(exact.verification).toEqual({ status: 'exact', checksumMatched: true });
    expect(exact.built.inputManifest.messageGroupIds).toEqual(['message:goal_1']);

    modelCall = { ...modelCall, inputChecksum: 'not-the-recorded-input' };
    await expect(service.inspect({ kind: 'model_call', modelCallId: modelCall.id }))
      .rejects.toMatchObject({ code: 'context_snapshot_unreconstructable' });
  });

  it('builds a StepRun snapshot from complete planned context', async () => {
    const plannedJob = job({
      id: 'job_plan',
      strategy: 'planned',
      stage: 'step_execution',
      metadata: { goalMessageId: 'goal_plan' },
    });
    const plannedMessages = [
      message({ id: 'history', rowId: 1, jobId: 'job_history', content: 'history' }),
      message({ id: 'goal_plan', rowId: 2, jobId: 'job_plan', content: 'planned goal' }),
      message({
        id: 'step_tail', rowId: 3, jobId: 'job_plan', stepRunId: 'run_1',
        role: 'assistant', messageType: 'assistant_message', content: 'step detail',
      }),
    ];
    const snapshot = await inspection(store({
      messages: plannedMessages,
      jobs: [plannedJob],
      plan: plan(),
      steps: [planStep()],
      runs: [stepRun()],
    })).inspect({ kind: 'step_run', stepRunId: 'run_1' });

    expect(snapshot.built.inputManifest.messageGroupIds).toEqual([
      'message:history', 'message:goal_plan', 'message:step_tail',
    ]);
    expect(snapshot.built.messages.map(item => item.content)).toContain('step detail');
  });
});

function inspection(store_: ContextInspectionStore): ContextInspectionService {
  return new ContextInspectionService({
    store: store_,
    tools: [],
    model: {
      provider: 'test', name: 'model', maxContextTokens: 10_000, reservedOutputTokens: 500,
    },
    systemPrompt: 'system',
    stepSystemPrompt: 'step system',
    systemPromptVersion: 'system-v1',
    compressionMessageThreshold: 50,
    clock: { nowMs: () => 100 },
  });
}

function store(input: {
  messages: AgentMessage[];
  jobs: AgentJob[];
  plan?: AgentPlan;
  steps?: AgentPlanStep[];
  runs?: AgentStepRun[];
  getModelCall?: () => AgentModelCall | undefined;
}): ContextInspectionStore {
  return {
    getSession: async () => session(),
    getJob: async id => input.jobs.find(item => item.id === id),
    getStepRun: async id => input.runs?.find(item => item.id === id),
    getModelCall: async () => input.getModelCall?.(),
    getPlanByJobId: async () => input.plan,
    listPlanSteps: async () => input.steps ?? [],
    listJobStepRuns: async () => input.runs ?? [],
    listSessionJobs: async () => input.jobs,
    listSessionMessages: async () => input.messages,
    listSessionToolInvocations: async () => [],
    listActiveContextSummaries: async () => [],
  };
}

function session(): AgentSession {
  return { id: 'session_1', status: 'active', version: 1, createdAtMs: 1, updatedAtMs: 1 };
}

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job_1',
    sessionId: 'session_1',
    strategy: 'direct',
    stage: 'direct_execution',
    status: 'completed',
    attemptNo: 1,
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'rowId'>): AgentMessage {
  return {
    sessionId: 'session_1',
    jobId: 'job_1',
    role: 'user',
    messageType: 'user_message',
    visibility: 'ui',
    channel: 'normal',
    content: 'goal',
    createdAtMs: 1,
    ...overrides,
  };
}

function plan(): AgentPlan {
  return {
    id: 'plan_1', sessionId: 'session_1', jobId: 'job_plan', title: 'plan', goal: 'planned goal',
    status: 'active', version: 1, createdAtMs: 1, updatedAtMs: 1,
  };
}

function planStep(): AgentPlanStep {
  return {
    id: 'step_1', planId: 'plan_1', position: 0, title: 'step', instruction: 'execute step',
    status: 'running', version: 1, createdAtMs: 1, updatedAtMs: 1,
  };
}

function stepRun(): AgentStepRun {
  return {
    id: 'run_1', sessionId: 'session_1', jobId: 'job_plan', planId: 'plan_1', stepId: 'step_1',
    runNo: 1, status: 'running', attemptNo: 1, version: 1, createdAtMs: 1, updatedAtMs: 1,
  };
}

function modelCallFixture(overrides: Partial<AgentModelCall>): AgentModelCall {
  return {
    id: 'model_call_1', sessionId: 'session_1', jobId: 'job_1', attemptId: 'attempt_1',
    logicalCallKey: 'job.react:1', callAttemptNo: 1, callType: 'job.react', status: 'completed',
    provider: 'test', model: 'model', contextRulesVersion: 'job-step-run-context-v5',
    inputManifest: {
      purpose: 'job_execution', contextRulesVersion: 'job-step-run-context-v5',
      systemPromptVersion: 'system-v1', messageGroupIds: [], summaryIds: [],
      fixedPrefixChecksum: 'checksum',
      estimatedBreakdown: { system: 1, tools: 0, summaries: 0, messages: 1, reservedOutput: 500 },
    },
    inputChecksum: 'checksum', maxContextTokens: 10_000, reservedOutputTokens: 500,
    estimatedInputTokens: 2, usageSource: 'unavailable',
    createdAtMs: 1,
    ...overrides,
  };
}
