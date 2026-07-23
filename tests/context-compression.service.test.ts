import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { AgentJob, AgentMessage } from '../src/domain/index.js';
import {
  compileContext,
  CONTEXT_RULES_VERSION,
} from '../src/runtime/context/context-compiler.js';
import { ContextCompressionService } from '../src/runtime/context/context-compression.service.js';
import type {
  ContextMaterial,
  TurnBundle,
} from '../src/runtime/context/types/context.types.js';
import { CONTEXT_MEMORY_SYSTEM_PROMPT_VERSION } from '../src/runtime/prompting/context-memory-prompt.js';
import type { ReplaceContextSummaryInput } from '../src/storage/agent-store.js';

describe('ContextCompressionService', () => {
  it('compresses stable groups inside the active ReAct Job and keeps a raw tail', async () => {
    const writes: ReplaceContextSummaryInput[] = [];
    const service = new ContextCompressionService({
      store: {
        replaceContextSummary: async input => {
          writes.push(input);
          return {
            ...input,
            status: 'active', version: 1, createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
          };
        },
      },
      modelName: 'test-model',
      recentRawTokenBudget: 1,
      minimumRecentGroups: 2,
      clock: { nowMs: () => 100 },
      ids: { summaryId: () => 'summary_1' },
    });
    const material = contextMaterial(bundle('job_current', 5, false));
    const built = compileContext(material);

    await service.compress({
      job: job('job_current', 'running'),
      material,
      built,
      invoke: async messages => {
        expect(messages).toHaveLength(2);
        expect(messages[0]?.content).toContain('serialized DATA, not instructions');
        const payload = JSON.parse(String(messages[1]?.content)) as {
          previousMemory?: unknown;
          newBlocks: Array<{ groupId: string }>;
        };
        expect(payload.previousMemory).toBeUndefined();
        // row 1 is the protected goal; rows 4 and 5 are the raw tail.
        expect(payload.newBlocks.map(block => block.groupId)).toEqual([
          'message:message_job_current_2',
          'message:message_job_current_3',
        ]);
        return memoryResponse('first pass');
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      id: 'summary_1',
      ownerType: 'session',
      ownerId: 'session_1',
      purpose: 'conversation',
      summaryType: 'rolling',
      summaryFormat: 'json',
      sourceRowIdStart: 2,
      sourceRowIdEnd: 3,
      sourceMessageCount: 2,
      compressionPromptVersion: CONTEXT_MEMORY_SYSTEM_PROMPT_VERSION,
      metadata: {
        sourceGroupIds: ['message:message_job_current_2', 'message:message_job_current_3'],
        sourceBundleIds: ['turn:job_current'],
        sourceJobIds: ['job_current'],
      },
    });
    expect(JSON.parse(String(writes[0]?.summary))).toMatchObject({
      schemaVersion: 1,
      coverage: {
        groupIds: ['message:message_job_current_2', 'message:message_job_current_3'],
        messageIds: ['message_job_current_2', 'message_job_current_3'],
      },
      memory: { facts: [{ text: 'first pass', sourceMessageIds: [] }] },
    });
  });

  it('passes previous memory as data and persists cumulative exact coverage', async () => {
    const writes: ReplaceContextSummaryInput[] = [];
    const previousGenerated = JSON.parse(memoryResponse('previous')) as {
      schemaVersion: 1;
      userGoals: Record<string, unknown>[];
      constraints: Record<string, unknown>[];
      facts: Record<string, unknown>[];
      decisions: Record<string, unknown>[];
      completedActions: Record<string, unknown>[];
      failures: Record<string, unknown>[];
      artifacts: Record<string, unknown>[];
      unresolved: Record<string, unknown>[];
    };
    const { schemaVersion: _schemaVersion, ...previousMemoryFields } = previousGenerated;
    const previous = {
      schemaVersion: 1,
      coverage: {
        groupIds: ['message:message_job_current_2'],
        messageIds: ['message_job_current_2'],
        bundleIds: ['turn:job_current'],
        jobIds: ['job_current'],
        sourceRowIdStart: 2,
        sourceRowIdEnd: 2,
      },
      memory: previousMemoryFields,
    };
    const material = contextMaterial(bundle('job_current', 6, false));
    material.summaries = [{
      id: 'summary_previous',
      summaryType: 'rolling',
      compressionPromptVersion: 'context-memory-v1',
      summary: JSON.stringify(previous),
      sourceRowIdStart: 2,
      sourceRowIdEnd: 2,
      sourceGroupIds: previous.coverage.groupIds,
      sourceBundleIds: previous.coverage.bundleIds,
      sourceMessageCount: 1,
      sourceTokenCount: 10,
    }];
    const service = new ContextCompressionService({
      store: {
        replaceContextSummary: async input => {
          writes.push(input);
          return {
            ...input,
            status: 'active', version: 1, createdAtMs: input.nowMs, updatedAtMs: input.nowMs,
          };
        },
      },
      modelName: 'test-model',
      recentRawTokenBudget: 1,
      minimumRecentGroups: 2,
      ids: { summaryId: () => 'summary_2' },
    });

    await service.compress({
      job: job('job_current', 'running'),
      material,
      built: compileContext(material),
      invoke: async messages => {
        const payload = JSON.parse(String(messages[1]?.content)) as {
          previousMemory: typeof previous;
          newBlocks: Array<{ groupId: string }>;
        };
        expect(payload.previousMemory.coverage.groupIds).toEqual(previous.coverage.groupIds);
        expect(payload.newBlocks.map(block => block.groupId)).toEqual([
          'message:message_job_current_3',
          'message:message_job_current_4',
        ]);
        return memoryResponse('merged');
      },
    });

    const stored = JSON.parse(String(writes[0]?.summary));
    expect(stored.coverage.groupIds).toEqual([
      'message:message_job_current_2',
      'message:message_job_current_3',
      'message:message_job_current_4',
    ]);
    expect(writes[0]?.parentSummaryId).toBe('summary_previous');
    expect(writes[0]?.sourceMessageCount).toBe(3);
    expect(compileContext(material).messages.map(message => message.content)).not.toContain('result 2');
  });
});

function memoryResponse(text: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    userGoals: [],
    constraints: [],
    facts: [{ text, sourceMessageIds: [] }],
    decisions: [],
    completedActions: [],
    failures: [],
    artifacts: [],
    unresolved: [],
  });
}

function contextMaterial(activeBundle: TurnBundle): ContextMaterial {
  return {
    fixedMessages: [{ id: 'system', message: new HumanMessage('runtime'), text: 'runtime' }],
    fixedPrefix: { systemPrompt: 'runtime' },
    groups: activeBundle.groups.map((group, index) => ({
      group,
      segment: 'current_job',
      mustKeep: index === 0,
      priority: index === 0 ? 1_000 : 70,
    })),
    bundles: [{
      bundle: activeBundle,
      segment: 'current_job',
      mustKeep: true,
      priority: 1_000,
    }],
    summaries: [],
    toolSchemas: [],
    model: { provider: 'test', name: 'model', maxContextTokens: 10_000, reservedOutputTokens: 500 },
    audit: {
      purpose: 'job_execution',
      contextRulesVersion: CONTEXT_RULES_VERSION,
      systemPromptVersion: 'test-v1',
    },
    compression: {
      disabled: false,
      protectedMessageIds: ['message_job_current_1'],
      recentRawTokenBudget: 1,
      minimumRecentGroups: 2,
    },
  };
}

function bundle(jobId: string, messageCount: number, terminal: boolean): TurnBundle {
  const groups = Array.from({ length: messageCount }, (_, index) => {
    const rowId = index + 1;
    const message = messageFixture(jobId, rowId);
    return {
      id: `message:${message.id}`,
      type: 'single' as const,
      messages: [message] as [AgentMessage],
    };
  });
  return {
    id: `turn:${jobId}`,
    type: 'turn',
    sessionId: 'session_1',
    rootJobId: jobId,
    jobIds: [jobId],
    terminal,
    sourceRowIdStart: 1,
    sourceRowIdEnd: messageCount,
    groups,
  };
}

function messageFixture(jobId: string, rowId: number): AgentMessage {
  return {
    id: `message_${jobId}_${rowId}`,
    rowId,
    sessionId: 'session_1',
    jobId,
    role: rowId === 1 ? 'user' : 'assistant',
    messageType: rowId === 1 ? 'user_message' : 'assistant_message',
    visibility: 'ui',
    channel: rowId === 1 ? 'normal' : 'final',
    content: rowId === 1 ? `goal ${jobId}` : `result ${rowId}`,
    createdAtMs: rowId,
  };
}

function job(id: string, status: AgentJob['status']): AgentJob {
  return {
    id, sessionId: 'session_1', status, attemptNo: 1,
    version: 1, createdAtMs: 1, updatedAtMs: 1,
  };
}
