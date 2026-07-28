import { createHash } from 'node:crypto';
import { mapChatMessagesToStoredMessages } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type {
  AgentJob,
  AgentContextSummary,
  AgentMessage,
  AgentModelCall,
  AgentSession,
} from '../src/domain/index.js';
import { CONTEXT_RULES_VERSION } from '../src/runtime/context/context-compiler.js';
import { stableStringify } from '../src/runtime/helpers/stable-json.helper.js';
import {
  ContextInspectionService,
  type ContextInspectionStore,
} from '../src/orchestration/context-inspection.service.js';

describe('ContextInspectionService', () => {
  it('uses the shared ReAct context and exact recorded ModelCall input', async () => {
    const messages = [message({ id: 'goal_1', rowId: 1, content: 'hello' })];
    const jobs = [job({ metadata: { goalMessageId: 'goal_1' } })];
    let modelCall: AgentModelCall | undefined;
    const service = inspection(store({ messages, jobs, getModelCall: () => modelCall }));

    const nextTurn = await service.inspect({ kind: 'next_turn', sessionId: 'session_1' });
    expect(nextTurn.built.messages.map(item => item.content)).toEqual(['system', 'hello']);

    const jobSnapshot = await service.inspect({ kind: 'job', jobId: 'job_1' });
    const inputMessages = mapChatMessagesToStoredMessages(jobSnapshot.built.messages);
    const serialized = stableStringify(inputMessages);
    modelCall = modelCallFixture({
      inputChecksum: createHash('sha256').update(serialized).digest('hex'),
      inputManifest: jobSnapshot.built.inputManifest,
      inputMessages,
    });
    messages.push(message({
      id: 'later_message', rowId: 2, role: 'assistant',
      messageType: 'assistant_message', content: 'added after the inspected call',
    }));
    const upgradedService = inspection(
      store({ messages, jobs, getModelCall: () => modelCall }),
      { systemPrompt: 'new system prompt', systemPromptVersion: 'system-v2' }
    );
    const exact = await upgradedService.inspect({
      kind: 'model_call',
      modelCallId: modelCall.id,
    });
    expect(exact.verification).toEqual({ status: 'exact', checksumMatched: true });
    expect(exact.built.inputManifest.messageGroupIds).toEqual(['message:goal_1']);
    expect(exact.built.messages.map(item => item.content)).toEqual(['system', 'hello']);

    modelCall = { ...modelCall, inputChecksum: 'not-the-recorded-input' };
    await expect(upgradedService.inspect({ kind: 'model_call', modelCallId: modelCall.id }))
      .rejects.toMatchObject({ code: 'context_snapshot_unreconstructable' });
  });

  it('reconstructs a ModelCall with a superseded historical Context Memory', async () => {
    const messages = [message({ id: 'goal_1', rowId: 1, content: 'hello' })];
    const jobs = [job({ metadata: { goalMessageId: 'goal_1' } })];
    const summary = contextSummary();
    let activeSummaries = [summary];
    let modelCall: AgentModelCall | undefined;
    const service = inspection(store({
      messages,
      jobs,
      getModelCall: () => modelCall,
      activeSummaries: () => activeSummaries,
    }));
    const snapshot = await service.inspect({ kind: 'job', jobId: 'job_1' });
    const inputMessages = mapChatMessagesToStoredMessages(snapshot.built.messages);
    modelCall = modelCallFixture({
      inputManifest: snapshot.built.inputManifest,
      inputMessages,
      inputChecksum: createHash('sha256').update(stableStringify(inputMessages)).digest('hex'),
    });
    activeSummaries = [];

    const exact = await service.inspect({ kind: 'model_call', modelCallId: modelCall.id });

    expect(exact.built.inputManifest.summaryIds).toEqual([summary.id]);
    expect(exact.built.messages.map(item => item.content))
      .toContain('Context memory (durable, compressed):\ncompressed');
  });

});

function inspection(
  store_: ContextInspectionStore,
  prompts: { systemPrompt: string; systemPromptVersion: string } = {
    systemPrompt: 'system',
    systemPromptVersion: 'system-v1',
  }
): ContextInspectionService {
  return new ContextInspectionService({
    store: store_,
    tools: [],
    model: {
      provider: 'test', name: 'model', maxContextTokens: 10_000, reservedOutputTokens: 500,
    },
    systemPrompt: prompts.systemPrompt,
    systemPromptVersion: prompts.systemPromptVersion,
    clock: { nowMs: () => 100 },
  });
}

function store(input: {
  messages: AgentMessage[];
  jobs: AgentJob[];
  getModelCall?: () => AgentModelCall | undefined;
  activeSummaries?: () => AgentContextSummary[];
}): ContextInspectionStore {
  return {
    sessions: {
      get: async () => session(),
      listJobs: async () => input.jobs,
      listMessages: async () => input.messages,
      listToolInvocations: async () => [],
      listPlans: async () => [],
      listPlanSteps: async () => [],
      listArtifacts: async () => [],
      listUserInputRequests: async () => [],
    } as ContextInspectionStore['sessions'],
    jobs: {
      get: async id => input.jobs.find(item => item.id === id),
    } as ContextInspectionStore['jobs'],
    models: {
      getCall: async () => input.getModelCall?.(),
      listRecentSessionCalls: async () => [],
    } as ContextInspectionStore['models'],
    context: {
      listActiveSummaries: async () => input.activeSummaries?.() ?? [],
    } as ContextInspectionStore['context'],
  };
}

function contextSummary(): AgentContextSummary {
  return {
    id: 'summary_1',
    sessionId: 'session_1',
    ownerType: 'session',
    ownerId: 'session_1',
    purpose: 'conversation',
    contextRulesVersion: CONTEXT_RULES_VERSION,
    summaryType: 'rolling',
    status: 'active',
    sourceRowIdStart: 1,
    sourceRowIdEnd: 1,
    summary: 'compressed',
    summaryFormat: 'json',
    sourceMessageCount: 0,
    compressionPromptVersion: 'legacy-test',
    checksum: 'checksum',
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function session(): AgentSession {
  return { id: 'session_1', status: 'active', version: 1, createdAtMs: 1, updatedAtMs: 1 };
}

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: 'job_1',
    sessionId: 'session_1',
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

function modelCallFixture(overrides: Partial<AgentModelCall>): AgentModelCall {
  return {
    id: 'model_call_1', sessionId: 'session_1', jobId: 'job_1', attemptId: 'attempt_1',
    logicalCallKey: 'job.react:1', callAttemptNo: 1, callType: 'job.react', status: 'completed',
    provider: 'test', model: 'model', contextRulesVersion: CONTEXT_RULES_VERSION,
    inputManifest: {
      purpose: 'job_execution', contextRulesVersion: CONTEXT_RULES_VERSION,
      systemPromptVersion: 'system-v1', messageGroupIds: [], summaryIds: [],
      fixedPrefixChecksum: 'checksum',
      estimatedBreakdown: { system: 1, tools: 0, summaries: 0, messages: 1, reservedOutput: 500 },
    },
    inputMessages: [],
    inputChecksum: 'checksum', maxContextTokens: 10_000, reservedOutputTokens: 500,
    estimatedInputTokens: 2, usageSource: 'unavailable',
    createdAtMs: 1,
    ...overrides,
  };
}
