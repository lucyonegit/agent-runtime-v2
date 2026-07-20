import { isToolMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentJob,
  AgentMessage,
  AgentPlan,
  AgentPlanStep,
  AgentToolInvocation,
} from '../src/domain/index.js';
import { ExecutionContextProvider } from '../src/orchestration/execution/execution-context-provider.js';
import { compileContext, CONTEXT_RULES_VERSION } from '../src/runtime/context/context-compiler.js';
import type { ContextMaterial, TurnBundle } from '../src/runtime/context/context-material.js';
import { JobContextLoader } from '../src/runtime/loaders/job-context-loader.js';
import type { RuntimeToolContext } from '../src/runtime/tool-executor.js';
import type { AgentStore } from '../src/storage/agent-store.js';
import { createPlanTools } from '../src/tools/plan-tools.js';

describe('unified ReAct planning', () => {
  it('persists update_plan through the durable store and publishes Plan entities', async () => {
    const applyPlanUpdate = vi.fn(async (input: Parameters<AgentStore['applyPlanUpdate']>[0]) => ({
      plan: plan({ id: input.planId, title: input.title, goal: input.goal }),
      steps: input.steps.map(step => planStep(step)),
    }));
    const publishedTypes: string[] = [];
    const publish = vi.fn(async (event: { type: string }) => {
      publishedTypes.push(event.type);
    });
    const store = {
      getJob: async () => job(),
      listSessionMessages: async () => [goalMessage()],
      getPlanByJobId: async () => undefined,
      listPlanSteps: async () => [],
      applyPlanUpdate,
    } as unknown as AgentStore;
    const runtimeTool = createPlanTools({
      store,
      workerId: 'worker_1',
      publisher: { publish: publish as never },
      clock: { nowMs: () => 100 },
      ids: { planId: () => 'plan_1', planStepId: () => 'step_1' },
    })[0]!;
    const context: RuntimeToolContext = {
      sessionId: 'session_1',
      jobId: 'job_1',
      sandboxRoot: '/tmp/runtime',
      attemptId: 'attempt_1',
      toolInvocationId: 'invocation_1',
      toolCallId: 'call_plan',
      idempotencyKey: 'job_1:call_plan',
    };

    const output = await runtimeTool.tool.invoke({
      type: 'tool_call',
      id: 'call_plan',
      name: 'update_plan',
      args: {
        title: 'Build report',
        explanation: 'The work needs research and synthesis.',
        steps: [{ key: 'research', title: 'Research', status: 'in_progress' }],
      },
    }, { configurable: { agentRuntimeContext: context } });

    expect(runtimeTool.exclusive).toBe(true);
    expect(runtimeTool.sideEffectLevel).toBe('idempotent');
    expect(isToolMessage(output)).toBe(true);
    expect(applyPlanUpdate).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan_1',
      expectedVersion: 0,
      goal: 'Create a report',
      metadata: expect.objectContaining({ lastToolCallId: 'call_plan' }),
      steps: [expect.objectContaining({
        id: 'step_1', key: 'research', position: 0, status: 'in_progress',
      })],
    }));
    expect(publishedTypes).toEqual([
      'plan.upserted', 'plan_step.upserted',
    ]);
  });

  it('carries Plan state through the ordinary durable update_plan tool exchange', async () => {
    const call = planCallMessage();
    const result = planResultMessage();
    const store = {
      listSessionJobs: async () => [job()],
      listSessionMessages: async () => [goalMessage(), call, result],
      listSessionToolInvocations: async () => [planInvocation(call, result)],
      listActiveContextSummaries: async () => [],
    };
    const loader = new JobContextLoader({
      store,
      systemPrompt: 'system',
      systemPromptVersion: 'system-v1',
      model: { provider: 'test', name: 'model', maxContextTokens: 10_000, reservedOutputTokens: 500 },
      toolSchemas: [],
      compressionMessageThreshold: 50,
    });
    const built = compileContext(await loader.load(job(), 'Create a report'));

    expect(built.messages.map(message => message.content)).toEqual([
      'system',
      'Create a report',
      '',
      expect.stringContaining('"status":"active"'),
    ]);
    expect(isToolMessage(built.messages.at(-1)!)).toBe(true);
    expect(String(built.messages.at(-1)?.content)).toContain('"status":"in_progress"');
  });

  it('uses one Job context provider and reloads after rolling compression', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(material(true))
      .mockResolvedValueOnce(material(false));
    const compress = vi.fn(async () => undefined);
    const provider = new ExecutionContextProvider({
      store: {} as AgentStore,
      modelName: 'model',
      jobContext: { load },
      compressionModels: { create: () => ({ invoke: async () => ({ text: 'summary' }) }) },
      sessionCompression: { compress },
    });

    const built = await provider.buildJobContext(job(), 'Create a report');
    expect(built.messages.map(message => message.content)).toEqual(['system', 'Create a report']);
    expect(load).toHaveBeenCalledTimes(2);
    expect(compress).toHaveBeenCalledTimes(1);
  });
});

function job(): AgentJob {
  return {
    id: 'job_1', sessionId: 'session_1', status: 'running', currentAttemptId: 'attempt_1',
    attemptNo: 1, version: 1, createdAtMs: 1, updatedAtMs: 1,
  };
}

function goalMessage(): AgentMessage {
  return {
    rowId: 1, id: 'goal_1', sessionId: 'session_1', jobId: 'job_1', role: 'user',
    messageType: 'user_message', visibility: 'ui', channel: 'normal',
    content: 'Create a report', createdAtMs: 1,
  };
}

function planCallMessage(): AgentMessage {
  return {
    rowId: 2, id: 'plan_call_message', sessionId: 'session_1', jobId: 'job_1',
    attemptId: 'attempt_1', outputId: 'output_plan', role: 'assistant',
    messageType: 'tool_call', visibility: 'ui', channel: 'normal', content: '',
    toolCalls: [{ id: 'call_plan', name: 'update_plan', args: { title: 'Build report' } }],
    createdAtMs: 2,
  };
}

function planResultMessage(): AgentMessage {
  const content = JSON.stringify({
    planId: 'plan_1', version: 0, status: 'active',
    steps: [{ key: 'research', status: 'in_progress' }],
  });
  return {
    rowId: 3, id: 'plan_result_message', sessionId: 'session_1', jobId: 'job_1',
    attemptId: 'attempt_1', role: 'tool', messageType: 'tool_result', visibility: 'ui',
    channel: 'normal', content, toolCallId: 'call_plan', toolName: 'update_plan',
    toolResult: { status: 'completed', result: JSON.parse(content), durationMs: 1 },
    createdAtMs: 3,
  };
}

function planInvocation(call: AgentMessage, result: AgentMessage): AgentToolInvocation {
  return {
    id: 'invocation_plan', sessionId: 'session_1', jobId: 'job_1', attemptId: 'attempt_1',
    callMessageId: call.id, resultMessageId: result.id, toolCallId: 'call_plan',
    toolName: 'update_plan', arguments: { title: 'Build report' }, argumentsChecksum: 'checksum',
    sideEffectLevel: 'idempotent', idempotencyKey: 'job_1:call_plan', status: 'completed',
    resultPayload: result.toolResult?.result, version: 1, createdAtMs: 2,
    startedAtMs: 2, completedAtMs: 3, updatedAtMs: 3,
  };
}

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: 'plan_1', sessionId: 'session_1', jobId: 'job_1', title: 'Build report',
    goal: 'Create a report', status: 'active', version: 0, createdAtMs: 1, updatedAtMs: 1,
    ...overrides,
  };
}

function planStep(input: Partial<AgentPlanStep> & Pick<AgentPlanStep, 'id' | 'key' | 'position' | 'title' | 'status'>): AgentPlanStep {
  return {
    planId: 'plan_1', version: 0, createdAtMs: 1, updatedAtMs: 1, ...input,
  };
}

function material(compressionRecommended: boolean): ContextMaterial {
  const message = goalMessage();
  const group = { id: 'message:goal_1', type: 'single' as const, messages: [message] as [AgentMessage] };
  const bundle: TurnBundle = {
    id: 'turn:job_1', type: 'turn', sessionId: 'session_1', rootJobId: 'job_1',
    jobIds: ['job_1'], terminal: false, sourceRowIdStart: 1, sourceRowIdEnd: 1,
    groups: [group],
  };
  return {
    fixedMessages: [{ id: 'system', message: new SystemMessage('system'), text: 'system' }],
    fixedPrefix: { systemPrompt: 'system' },
    groups: [{ group, segment: 'current_job', mustKeep: true, priority: 1_000 }],
    bundles: [{ bundle, segment: 'current_job', mustKeep: true, priority: 1_000 }],
    summaries: [],
    toolSchemas: [],
    model: { provider: 'test', name: 'model', maxContextTokens: 10_000, reservedOutputTokens: 500 },
    audit: {
      purpose: 'job_execution',
      contextRulesVersion: CONTEXT_RULES_VERSION,
      systemPromptVersion: 'system-v1',
    },
    compression: {
      disabled: !compressionRecommended,
      newCompressibleMessageCount: compressionRecommended ? 1 : 0,
      messageThreshold: 1,
    },
  };
}
