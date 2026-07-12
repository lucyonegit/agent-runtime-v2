import { describe, expect, it } from 'vitest';
import type {
  AgentContextSummary,
  AgentJob,
  AgentMessage,
  AgentPlan,
  AgentPlanStep,
  AgentStepRun,
  AgentToolInvocation,
} from '../src/domain/index.js';
import { compileContext } from '../src/runtime/context/context-compiler.js';
import {
  DirectJobContextLoader,
  type DirectJobContextStore,
} from '../src/runtime/loaders/direct-job-context-loader.js';
import {
  StepContextLoader,
  type StepContextStore,
} from '../src/runtime/loaders/step-context-loader.js';

describe('DirectJobContextLoader', () => {
  it('keeps complete visible Session history and the current goal once', async () => {
    const messages = [
      message({ id: 'history_user', rowId: 1, jobId: 'job_history', content: 'old goal' }),
      message({
        id: 'history_call', rowId: 2, jobId: 'job_history', stepRunId: 'run_history',
        role: 'assistant', messageType: 'tool_call', content: '',
        toolCalls: [{ id: 'tool_1', name: 'lookup', args: { q: 'old' } }],
      }),
      message({
        id: 'history_result', rowId: 3, jobId: 'job_history', stepRunId: 'run_history',
        role: 'tool', messageType: 'tool_result', content: 'found',
        toolCallId: 'tool_1', toolName: 'lookup',
        toolResult: { status: 'completed', result: { found: true } },
      }),
      message({
        id: 'history_output', rowId: 4, jobId: 'job_history', stepRunId: 'run_history',
        role: 'assistant', messageType: 'step_output', content: 'validated old output',
      }),
      message({ id: 'current_goal', rowId: 5, jobId: 'job_current', content: 'new goal' }),
    ];
    const invocations = [invocation(messages[1]!, messages[2]!)];
    const loader = directLoader(store({ messages, invocations }));
    const material = await loader.load(job({
      id: 'job_current',
      metadata: { goalMessageId: 'current_goal' },
    }), 'new goal');
    const compiled = compileContext(material);

    expect(compiled.inputManifest.messageGroupIds).toEqual([
      'message:history_user',
      'tool_exchange:history_call',
      'step_output:history_output',
      'message:current_goal',
    ]);
    expect(compiled.mustKeepMessageIds).toEqual(['current_goal']);
    expect(compiled.messages.map(item => item.content)).toEqual([
      'system', 'old goal', '', 'found', 'validated old output', 'new goal',
    ]);
  });

  it('marks a retry source goal as must-keep without duplicating it', async () => {
    const messages = [
      message({ id: 'source_goal', rowId: 1, jobId: 'job_failed', content: 'retry me' }),
      message({
        id: 'failed_answer', rowId: 2, jobId: 'job_failed', role: 'assistant',
        messageType: 'assistant_message', content: 'failed',
      }),
    ];
    const material = await directLoader(store({ messages })).load(job({
      id: 'job_retry',
      retryOfJobId: 'job_failed',
      metadata: { goalMessageId: 'source_goal' },
    }), 'retry me');

    expect(material.groups.filter(item => item.mustKeep).map(item => item.group.id))
      .toEqual(['message:source_goal']);
    expect(compileContext(material).messages.map(item => item.content))
      .toEqual(['system', 'retry me', 'failed']);
  });
});

describe('StepContextLoader', () => {
  it('includes the complete Session baseline and every previous StepRun message', async () => {
    const stepOutput = {
      schemaVersion: 1 as const,
      summary: 'step one result',
      artifacts: [], evidence: [], unresolved: [],
    };
    const messages = [
      message({ id: 'session_user', rowId: 1, jobId: 'job_history', content: 'old context' }),
      message({
        id: 'session_assistant', rowId: 2, jobId: 'job_history', role: 'assistant',
        messageType: 'assistant_message', content: 'old answer',
      }),
      message({ id: 'current_goal', rowId: 3, jobId: 'job_plan', content: 'do a plan' }),
      message({
        id: 'plan_created', rowId: 4, jobId: 'job_plan', role: 'assistant',
        messageType: 'plan_created', content: 'plan title',
      }),
      message({
        id: 'step1_failed_text', rowId: 5, jobId: 'job_plan', stepRunId: 'run_1_failed',
        role: 'assistant', messageType: 'assistant_message', content: 'failed attempt detail',
      }),
      message({
        id: 'step1_call', rowId: 6, jobId: 'job_plan', stepRunId: 'run_1_success',
        role: 'assistant', messageType: 'tool_call', content: '',
        toolCalls: [{ id: 'step_tool', name: 'lookup', args: { q: 'plan' } }],
      }),
      message({
        id: 'step1_result', rowId: 7, jobId: 'job_plan', stepRunId: 'run_1_success',
        role: 'tool', messageType: 'tool_result', content: 'tool evidence',
        toolCallId: 'step_tool', toolName: 'lookup',
        toolResult: { status: 'completed', result: { evidence: true } },
      }),
      message({
        id: 'step1_output', rowId: 8, jobId: 'job_plan', stepRunId: 'run_1_success',
        role: 'assistant', messageType: 'step_output', content: JSON.stringify(stepOutput),
        metadata: { structuredOutput: stepOutput },
      }),
      message({
        id: 'step2_tail', rowId: 9, jobId: 'job_plan', stepRunId: 'run_2',
        role: 'assistant', messageType: 'assistant_message', content: 'current tail',
      }),
    ];
    const invocations = [stepInvocation(messages[5]!, messages[6]!)];
    const steps = [
      planStep({ id: 'step_1', position: 0, status: 'completed', outputMessageId: 'step1_output' }),
      planStep({ id: 'step_2', position: 1, status: 'running', instruction: 'do step two' }),
    ];
    const runs = [
      stepRun({ id: 'run_1_failed', stepId: 'step_1', runNo: 1, status: 'failed' }),
      stepRun({ id: 'run_1_success', stepId: 'step_1', runNo: 2, status: 'completed' }),
      stepRun({ id: 'run_2', stepId: 'step_2', runNo: 1, status: 'running' }),
    ];
    const loader = new StepContextLoader({
      store: stepStore({ messages, invocations, steps, runs }),
      systemPrompt: 'step system',
      systemPromptVersion: 'step-v1',
      model: {
        provider: 'test', name: 'model', maxContextTokens: 20_000, reservedOutputTokens: 500,
      },
      toolSchemas: [],
      compressionMessageThreshold: 50,
    });
    const material = await loader.load({
      job: job({
        id: 'job_plan', strategy: 'planned', stage: 'step_execution',
        metadata: { goalMessageId: 'current_goal' },
      }),
      originalGoal: 'do a plan',
      step: steps[1]!,
      stepRun: runs[2]!,
    });
    const compiled = compileContext(material);

    expect(compiled.inputManifest.messageGroupIds).toEqual([
      'message:session_user',
      'message:session_assistant',
      'message:current_goal',
      'message:step1_failed_text',
      'tool_exchange:step1_call',
      'step_output:step1_output',
      'message:step2_tail',
    ]);
    expect(material.groups
      .filter(item => item.segment === 'current_plan' || item.segment === 'current_step')
      .every(item => item.mustKeep)).toBe(true);
    expect(compiled.mustKeepMessageIds).toEqual([
      'current_goal',
      'step1_failed_text',
      'step1_call',
      'step1_result',
      'step1_output',
      'step2_tail',
    ]);
    expect(compiled.messages.map(item => item.content)).toContain('tool evidence');
    expect(compiled.messages.map(item => item.content)).toContain('current tail');
    const contents = compiled.messages.map(item => item.content);
    const currentInstruction =
      'Current PlanStep — execute only this step. Do not execute later PlanSteps:\ndo step two';
    expect(contents.indexOf('current tail')).toBeLessThan(contents.indexOf(currentInstruction));
    expect(contents.at(-1)).toBe(currentInstruction);
  });
});

function directLoader(store_: DirectJobContextStore): DirectJobContextLoader {
  return new DirectJobContextLoader({
    store: store_,
    systemPrompt: 'system',
    systemPromptVersion: 'system-v1',
    model: {
      provider: 'test', name: 'model', maxContextTokens: 10_000, reservedOutputTokens: 500,
    },
    toolSchemas: [],
    compressionMessageThreshold: 50,
  });
}

function store(input: {
  messages?: AgentMessage[];
  invocations?: AgentToolInvocation[];
  summaries?: AgentContextSummary[];
  jobs?: AgentJob[];
}): DirectJobContextStore {
  const jobs = input.jobs ?? [...new Set((input.messages ?? []).map(item => item.jobId))]
    .map(id => job({
      id,
      status: id === 'job_current' ? 'running' : 'completed',
      completedAtMs: id === 'job_current' ? undefined : 2,
    }));
  return {
    listSessionJobs: async () => jobs,
    listSessionMessages: async () => input.messages ?? [],
    listSessionPlans: async () => [],
    listSessionPlanSteps: async () => [],
    listSessionStepRuns: async () => [],
    listSessionToolInvocations: async () => input.invocations ?? [],
    listActiveContextSummaries: async () => input.summaries ?? [],
  };
}

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job_current',
    sessionId: 'session_1',
    stage: 'direct_execution',
    status: 'running',
    attemptNo: 1,
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'id'>): AgentMessage {
  return {
    rowId: 1,
    sessionId: 'session_1',
    jobId: 'job_current',
    role: 'user',
    messageType: 'user_message',
    visibility: 'ui',
    channel: 'normal',
    content: 'goal',
    createdAtMs: 1,
    ...overrides,
  };
}

function invocation(call: AgentMessage, result: AgentMessage): AgentToolInvocation {
  return {
    id: 'invocation_1',
    sessionId: call.sessionId,
    jobId: call.jobId!,
    stepRunId: call.stepRunId,
    attemptId: 'attempt_1',
    toolCallId: 'tool_1',
    callMessageId: call.id,
    toolName: 'lookup',
    arguments: { q: 'old' },
    argumentsChecksum: 'checksum_1',
    sideEffectLevel: 'read_only',
    idempotencyKey: 'idempotency_1',
    status: 'completed',
    resultMessageId: result.id,
    resultPayload: { found: true },
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function stepInvocation(call: AgentMessage, result: AgentMessage): AgentToolInvocation {
  return {
    ...invocation(call, result),
    id: 'step_invocation',
    jobId: 'job_plan',
    stepRunId: 'run_1_success',
    toolCallId: 'step_tool',
    arguments: { q: 'plan' },
  };
}

function stepStore(input: {
  messages: AgentMessage[];
  invocations: AgentToolInvocation[];
  steps: AgentPlanStep[];
  runs: AgentStepRun[];
}): StepContextStore {
  const jobs = [...new Set(input.messages.map(item => item.jobId))].map(id => job({
    id,
    strategy: id === 'job_plan' ? 'planned' : 'direct',
    status: id === 'job_plan' ? 'running' : 'completed',
  }));
  return {
    listSessionJobs: async () => jobs,
    listSessionMessages: async () => input.messages,
    listSessionPlans: async () => [plan()],
    listSessionPlanSteps: async () => input.steps,
    listSessionStepRuns: async () => input.runs,
    listSessionToolInvocations: async () => input.invocations,
    getPlanByJobId: async () => plan(),
    listPlanSteps: async () => input.steps,
    listJobStepRuns: async () => input.runs,
    listActiveContextSummaries: async () => [],
  };
}

function plan(): AgentPlan {
  return {
    id: 'plan_1',
    sessionId: 'session_1',
    jobId: 'job_plan',
    title: 'plan title',
    goal: 'do a plan',
    status: 'active',
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function planStep(overrides: Partial<AgentPlanStep> & Pick<AgentPlanStep, 'id'>): AgentPlanStep {
  return {
    planId: 'plan_1',
    position: 0,
    title: 'step',
    instruction: 'do step',
    status: 'pending',
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function stepRun(overrides: Partial<AgentStepRun> & Pick<AgentStepRun, 'id'>): AgentStepRun {
  return {
    sessionId: 'session_1',
    jobId: 'job_plan',
    planId: 'plan_1',
    stepId: 'step_1',
    runNo: 1,
    status: 'created',
    attemptNo: 1,
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}
