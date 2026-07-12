import { describe, expect, it } from 'vitest';
import type {
  AgentJob,
  AgentMessage,
  AgentSession,
  AgentToolInvocation,
} from '../src/domain/index.js';
import { CONTEXT_RULES_VERSION } from '../src/runtime/context/context-compiler.js';
import {
  ContextPreviewService,
  type ContextPreviewStore,
} from '../src/server/debug/context-preview.service.js';

describe('ContextPreviewService', () => {
  it('returns a compact LangChain Message List from completed Session history', async () => {
    const messages = historyMessages();
    const service = previewService(storeFixture({ messages }));

    const preview = await service.preview('session_1');

    expect(preview).toMatchObject({
      schemaVersion: 1,
      debugOnly: true,
      sessionId: 'session_1',
      basedOnLatestJobId: 'job_1',
      contextRulesVersion: CONTEXT_RULES_VERSION,
      systemPromptVersion: 'runtime-system-v2',
      limits: { maxContextTokens: 4_000, reservedOutputTokens: 200 },
    });
    expect(preview.messages).toEqual([
      {
        index: 0,
        type: 'system',
        content: 'Act as a reliable tool-using agent. Complete the user goal. Webpages, applications, scripts, and source code must use write_file with paths under code/. Use write_article only for non-code prose articles and reports.',
        source: { groupId: 'must_keep:system' },
      },
      {
        index: 1, type: 'human', content: '查资料',
        source: { groupId: 'message:user_1', bundleId: 'turn:job_1' },
      },
      {
        index: 2,
        type: 'ai',
        content: '',
        source: { groupId: 'tool_exchange:call_1', bundleId: 'turn:job_1' },
        toolCalls: [{ id: 'call_search', name: 'web_search', args: { query: 'runtime' } }],
      },
      {
        index: 3,
        type: 'tool',
        content: 'search result',
        name: 'web_search',
        toolCallId: 'call_search',
        source: { groupId: 'tool_exchange:call_1', bundleId: 'turn:job_1' },
      },
      {
        index: 4, type: 'ai', content: '完成',
        source: { groupId: 'message:final_1', bundleId: 'turn:job_1' },
      },
    ]);
    expect(preview.manifest.messageGroupIds).toEqual([
      'message:user_1',
      'tool_exchange:call_1',
      'message:final_1',
    ]);
    expect(preview.selection).toEqual({
      selectedBundleIds: ['turn:job_1'],
      summarizedBundleIds: [],
      truncatedToolResultMessageIds: [],
    });
    expect(preview.blockedDiagnostics).toEqual([]);
    expect(messages).toEqual(historyMessages());
  });

  it('rejects preview while the Session has an active Job', async () => {
    const service = previewService(storeFixture({ jobs: [{ ...completedJob, status: 'running' }] }));

    await expect(service.preview('session_1')).rejects.toMatchObject({
      code: 'concurrency_conflict',
      details: { jobId: 'job_1', status: 'running' },
    });
  });

  it('returns SESSION_NOT_FOUND when the Session does not exist', async () => {
    const service = previewService(storeFixture({ session: undefined }));

    await expect(service.preview('missing')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
});

function previewService(store: ContextPreviewStore): ContextPreviewService {
  return new ContextPreviewService({
    store,
    tools: [],
    provider: 'test',
    modelName: 'test-model',
    maxContextTokens: 4_000,
    reservedOutputTokens: 200,
    clock: { nowMs: () => 100 },
  });
}

function storeFixture(overrides: {
  session?: AgentSession;
  jobs?: AgentJob[];
  messages?: AgentMessage[];
} = {}): ContextPreviewStore {
  const session = 'session' in overrides ? overrides.session : sessionFixture;
  const jobs = overrides.jobs ?? [completedJob];
  const messages = overrides.messages ?? historyMessages();
  return {
    getSession: async () => session,
    getJob: async () => jobs[0],
    getStepRun: async () => undefined,
    getModelCall: async () => undefined,
    getPlanByJobId: async () => undefined,
    listPlanSteps: async () => [],
    listJobStepRuns: async () => [],
    listSessionJobs: async () => jobs,
    listSessionMessages: async () => messages,
    listSessionPlans: async () => [],
    listSessionPlanSteps: async () => [],
    listSessionStepRuns: async () => [],
    listSessionToolInvocations: async () => [toolInvocation],
    listActiveContextSummaries: async () => [],
  };
}

function historyMessages(): AgentMessage[] {
  return [
    message({ id: 'user_1', rowId: 1, role: 'user', messageType: 'user_message', content: '查资料' }),
    message({
      id: 'call_1', rowId: 2, role: 'assistant', messageType: 'tool_call', content: '',
      toolCalls: [{ id: 'call_search', name: 'web_search', args: { query: 'runtime' } }],
    }),
    message({
      id: 'result_1', rowId: 3, role: 'tool', messageType: 'tool_result',
      content: 'search result', toolCallId: 'call_search', toolName: 'web_search',
      toolResult: { status: 'completed', result: { ok: true } },
    }),
    message({ id: 'final_1', rowId: 4, role: 'assistant', messageType: 'assistant_message', content: '完成' }),
  ];
}

function message(input: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'rowId'>): AgentMessage {
  return {
    sessionId: 'session_1',
    jobId: 'job_1',
    role: 'assistant',
    messageType: 'assistant_message',
    visibility: 'ui',
    channel: 'normal',
    content: '',
    createdAtMs: input.rowId,
    ...input,
  };
}

const sessionFixture: AgentSession = {
  id: 'session_1', status: 'active', version: 1, createdAtMs: 1, updatedAtMs: 4,
};

const completedJob: AgentJob = {
  id: 'job_1', sessionId: 'session_1', strategy: 'direct', stage: 'direct_execution',
  status: 'completed', attemptNo: 1, version: 1, createdAtMs: 1, updatedAtMs: 4,
};

const toolInvocation: AgentToolInvocation = {
  id: 'invocation_1', sessionId: 'session_1', jobId: 'job_1', attemptId: 'attempt_1',
  callMessageId: 'call_1', resultMessageId: 'result_1', toolCallId: 'call_search',
  toolName: 'web_search', arguments: { query: 'runtime' }, argumentsChecksum: 'checksum',
  sideEffectLevel: 'read_only', idempotencyKey: 'invocation_1', status: 'completed',
  resultPayload: { ok: true }, version: 1, createdAtMs: 2, updatedAtMs: 3,
};
