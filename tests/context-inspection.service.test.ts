import { createHash } from 'node:crypto';
import { mapChatMessagesToStoredMessages } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type {
  AgentJob,
  AgentMessage,
  AgentModelCall,
  AgentSession,
} from '../src/domain/index.js';
import { CONTEXT_RULES_VERSION } from '../src/runtime/context/context-compiler.js';
import { canonicalJson } from '../src/runtime/transaction-commands.js';
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
    const inputMessages = mapChatMessagesToStoredMessages(jobSnapshot.built.messages);
    const serialized = canonicalJson(inputMessages);
    modelCall = modelCallFixture({
      inputChecksum: createHash('sha256').update(serialized).digest('hex'),
      inputManifest: jobSnapshot.built.inputManifest,
      inputMessages,
    });
    messages.push(message({
      id: 'later_message', rowId: 2, role: 'assistant',
      messageType: 'assistant_message', content: 'added after the inspected call',
    }));
    const exact = await service.inspect({ kind: 'model_call', modelCallId: modelCall.id });
    expect(exact.verification).toEqual({ status: 'exact', checksumMatched: true });
    expect(exact.built.inputManifest.messageGroupIds).toEqual(['message:goal_1']);

    modelCall = { ...modelCall, inputChecksum: 'not-the-recorded-input' };
    await expect(service.inspect({ kind: 'model_call', modelCallId: modelCall.id }))
      .rejects.toMatchObject({ code: 'context_snapshot_unreconstructable' });
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
    systemPromptVersion: 'system-v1',
    compressionMessageThreshold: 50,
    clock: { nowMs: () => 100 },
  });
}

function store(input: {
  messages: AgentMessage[];
  jobs: AgentJob[];
  getModelCall?: () => AgentModelCall | undefined;
}): ContextInspectionStore {
  return {
    getSession: async () => session(),
    getJob: async id => input.jobs.find(item => item.id === id),
    getModelCall: async () => input.getModelCall?.(),
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
