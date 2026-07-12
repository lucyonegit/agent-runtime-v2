import { SystemMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentJob,
  AgentMessage,
  AgentPlanStep,
  AgentStepRun,
} from '../src/domain/index.js';
import { ExecutionContextProvider } from '../src/orchestration/execution/execution-context-provider.js';
import type { ContextMaterial, TurnBundle } from '../src/runtime/context/context-material.js';
import type { AgentStore } from '../src/storage/agent-store.js';

describe('ExecutionContextProvider', () => {
  it('uses Session compression for planning/direct context and reloads once', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(material({ compressionRecommended: true, bundles: true }))
      .mockResolvedValueOnce(material({ compressionRecommended: false, bundles: true }));
    const sessionCompress = vi.fn(async () => undefined);
    const stepCompress = vi.fn(async () => undefined);
    const provider = providerFixture({ loadDirect: load, sessionCompress, stepCompress });

    const built = await provider.buildPlanningContext(jobFixture(), 'goal');

    expect(built.messages.map(message => message.content)).toEqual(['system', 'goal']);
    expect(load).toHaveBeenCalledTimes(2);
    expect(sessionCompress).toHaveBeenCalledTimes(1);
    expect(stepCompress).not.toHaveBeenCalled();
  });

  it('uses StepRun compression for step context and reloads once', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(material({ compressionRecommended: true, bundles: true }))
      .mockResolvedValueOnce(material({ compressionRecommended: false, bundles: true }));
    const sessionCompress = vi.fn(async () => undefined);
    const stepCompress = vi.fn(async () => undefined);
    const provider = providerFixture({ loadStep: load, sessionCompress, stepCompress });

    await provider.buildStepContext({
      job: jobFixture(),
      originalGoal: 'goal',
      step: stepFixture(),
      stepRun: stepRunFixture(),
    });

    expect(load).toHaveBeenCalledTimes(2);
    expect(stepCompress).toHaveBeenCalledTimes(1);
    expect(sessionCompress).not.toHaveBeenCalled();
  });

  it('returns the first compiled Context without compression or reload', async () => {
    const load = vi.fn().mockResolvedValue(material({
      compressionRecommended: false,
      bundles: true,
    }));
    const provider = providerFixture({ loadDirect: load });

    const built = await provider.buildDirectContext(jobFixture(), 'goal');

    expect(built.compressionRecommended).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

function providerFixture(input: {
  loadDirect?: () => Promise<ContextMaterial>;
  loadStep?: () => Promise<ContextMaterial>;
  sessionCompress?: (input: unknown) => Promise<void>;
  stepCompress?: (input: unknown) => Promise<void>;
}): ExecutionContextProvider {
  const fallback = async () => material({ compressionRecommended: false, bundles: true });
  return new ExecutionContextProvider({
    store: {} as AgentStore,
    modelName: 'test-model',
    directContext: { load: input.loadDirect ?? fallback },
    stepContext: { load: input.loadStep ?? fallback },
    compressionModels: {
      create: () => ({ invoke: async () => ({ text: 'summary' }) }),
    },
    ...(input.sessionCompress ? {
      sessionCompression: { compress: input.sessionCompress },
    } : {
      sessionCompression: { compress: async () => undefined },
    }),
    ...(input.stepCompress ? {
      stepCompression: { compress: input.stepCompress },
    } : {
      stepCompression: { compress: async () => undefined },
    }),
  });
}

function material(input: {
  compressionRecommended: boolean;
  bundles: boolean;
}): ContextMaterial {
  const message = messageFixture();
  const group = { id: `message:${message.id}`, type: 'single' as const, messages: [message] as [AgentMessage] };
  const bundle: TurnBundle = {
    id: 'turn:job_1',
    type: 'direct_turn',
    sessionId: 'session_1',
    rootJobId: 'job_1',
    jobIds: ['job_1'],
    terminal: false,
    sourceRowIdStart: 1,
    sourceRowIdEnd: 1,
    groups: [group],
  };
  return {
    fixedMessages: [{ id: 'system', message: new SystemMessage('system'), text: 'system' }],
    fixedPrefix: { systemPrompt: 'system' },
    groups: [{ group, segment: 'current_job', mustKeep: true, priority: 1_000 }],
    ...(input.bundles ? {
      bundles: [{ bundle, segment: 'current_job', mustKeep: true, priority: 1_000 }],
    } : {}),
    summaries: [],
    toolSchemas: [],
    model: {
      provider: 'test', name: 'test-model', maxContextTokens: 10_000, reservedOutputTokens: 500,
    },
    audit: {
      purpose: 'job_execution',
      contextRulesVersion: 'job-step-run-context-v6',
      systemPromptVersion: 'test-v1',
    },
    compression: {
      disabled: !input.compressionRecommended,
      newCompressibleMessageCount: input.compressionRecommended ? 1 : 0,
      messageThreshold: 1,
    },
  };
}

function jobFixture(): AgentJob {
  return {
    id: 'job_1', sessionId: 'session_1', stage: 'direct_execution', status: 'running',
    currentAttemptId: 'attempt_1', attemptNo: 1, version: 1, createdAtMs: 1, updatedAtMs: 1,
  };
}

function messageFixture(): AgentMessage {
  return {
    rowId: 1, id: 'goal_1', sessionId: 'session_1', jobId: 'job_1', role: 'user',
    messageType: 'user_message', visibility: 'ui', channel: 'normal', content: 'goal', createdAtMs: 1,
  };
}

function stepFixture(): AgentPlanStep {
  return {
    id: 'step_1', planId: 'plan_1', position: 0, title: 'step', instruction: 'do step',
    status: 'running', version: 1, createdAtMs: 1, updatedAtMs: 1,
  };
}

function stepRunFixture(): AgentStepRun {
  return {
    id: 'run_1', sessionId: 'session_1', jobId: 'job_1', planId: 'plan_1', stepId: 'step_1',
    runNo: 1, status: 'running', currentAttemptId: 'attempt_1', attemptNo: 1,
    version: 1, createdAtMs: 1, updatedAtMs: 1,
  };
}
