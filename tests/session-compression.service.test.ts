import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { AgentJob, AgentMessage } from '../src/domain/index.js';
import { compileContext } from '../src/runtime/context/context-compiler.js';
import type { ContextMaterial, TurnBundle } from '../src/runtime/context/context-material.js';
import { SessionCompressionService } from '../src/runtime/context/session-compression.service.js';
import type { ReplaceContextSummaryInput } from '../src/storage/agent-store.js';

describe('SessionCompressionService', () => {
  it('summarizes only a complete contiguous prefix and persists a session rolling summary', async () => {
    const writes: ReplaceContextSummaryInput[] = [];
    const service = new SessionCompressionService({
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
      retainedRecentBundles: 1,
      clock: { nowMs: () => 100 },
      ids: { summaryId: () => 'summary_1' },
    });
    const material = contextMaterial([
      bundle('job_1', 1, true),
      bundle('job_2', 2, true),
      bundle('job_3', 3, true),
      bundle('job_current', 4, false),
    ]);
    const built = compileContext(material);

    await service.compress({
      job: job('job_current', 'running'),
      material,
      built,
      invoke: async messages => {
        expect(messages.map(message => message.content)).toContain('goal job_1');
        expect(messages.map(message => message.content)).toContain('goal job_2');
        expect(messages.map(message => message.content)).not.toContain('goal job_3');
        expect(messages.map(message => message.content)).not.toContain('goal job_current');
        return JSON.stringify({
          schemaVersion: 1,
          userGoals: ['goal job_1', 'goal job_2'],
          decisions: ['done'],
          planOutcomes: [],
          artifacts: [],
          unresolved: [],
        });
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
      sourceRowIdStart: 1,
      sourceRowIdEnd: 2,
      sourceMessageCount: 2,
      metadata: {
        sourceBundleIds: ['turn:job_1', 'turn:job_2'],
        sourceJobIds: ['job_1', 'job_2'],
      },
    });
    expect(JSON.parse(String(writes[0]?.summary))).toMatchObject({
      schemaVersion: 1,
      sourceBundleIds: ['turn:job_1', 'turn:job_2'],
      sourceJobIds: ['job_1', 'job_2'],
    });
  });
});

function contextMaterial(bundles: TurnBundle[]): ContextMaterial {
  return {
    fixedMessages: [{ id: 'system', message: new HumanMessage('runtime'), text: 'runtime' }],
    fixedPrefix: { systemPrompt: 'runtime' },
    groups: bundles.flatMap(item => item.groups).map(group => ({
      group, segment: 'session_history', mustKeep: false, priority: 40,
    })),
    bundles: bundles.map(item => ({
      bundle: item,
      segment: item.rootJobId === 'job_current' ? 'current_job' : 'session_history',
      mustKeep: item.rootJobId === 'job_current',
      priority: item.rootJobId === 'job_current' ? 1_000 : 40,
    })),
    summaries: [],
    toolSchemas: [],
    model: { provider: 'test', name: 'model', maxContextTokens: 10_000, reservedOutputTokens: 500 },
    audit: {
      purpose: 'job_execution',
      contextRulesVersion: 'unified-job-react-context-v1',
      systemPromptVersion: 'test-v1',
    },
    compression: {
      disabled: false, newCompressibleMessageCount: 100, messageThreshold: 50,
    },
  };
}

function bundle(jobId: string, rowId: number, terminal: boolean): TurnBundle {
  const message = messageFixture(jobId, rowId);
  return {
    id: `turn:${jobId}`,
    type: 'turn',
    sessionId: 'session_1',
    rootJobId: jobId,
    jobIds: [jobId],
    terminal,
    sourceRowIdStart: rowId,
    sourceRowIdEnd: rowId,
    groups: [{ id: `message:${message.id}`, type: 'single', messages: [message] }],
  };
}

function messageFixture(jobId: string, rowId: number): AgentMessage {
  return {
    id: `message_${jobId}`, rowId, sessionId: 'session_1', jobId,
    role: 'user', messageType: 'user_message', visibility: 'ui', channel: 'normal',
    content: `goal ${jobId}`, createdAtMs: rowId,
  };
}

function job(id: string, status: AgentJob['status']): AgentJob {
  return {
    id, sessionId: 'session_1', status, attemptNo: 1,
    version: 1, createdAtMs: 4, updatedAtMs: 4,
  };
}
