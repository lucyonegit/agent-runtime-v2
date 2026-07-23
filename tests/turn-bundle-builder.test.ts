import { describe, expect, it } from 'vitest';
import type { AgentJob, AgentMessage } from '../src/domain/index.js';
import { TurnBundleBuilder } from '../src/runtime/context/helpers/turn-bundle.helper.js';
import type { MessageGroup } from '../src/runtime/context/types/message-group.types.js';

describe('TurnBundleBuilder', () => {
  it('keeps retry lineage in one atomic turn ordered by persisted rows', () => {
    const groups: MessageGroup[] = [
      single(message('answer_retry', 3, 'job_retry', 'assistant')),
      single(message('goal', 1, 'job_root', 'user')),
      single(message('answer_failed', 2, 'job_root', 'assistant')),
    ];
    const bundles = new TurnBundleBuilder().build({
      sessionId: 'session_1',
      jobs: [
        job({ id: 'job_root', status: 'failed' }),
        job({ id: 'job_retry', retryOfJobId: 'job_root', status: 'completed' }),
      ],
      groups,
    });

    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      id: 'turn:job_root',
      type: 'turn',
      rootJobId: 'job_root',
      jobIds: ['job_root', 'job_retry'],
      terminal: true,
      sourceRowIdStart: 1,
      sourceRowIdEnd: 3,
    });
    expect(bundles[0]!.groups.map(group => group.id)).toEqual([
      'message:goal', 'message:answer_failed', 'message:answer_retry',
    ]);
  });

  it('marks a running lineage as non-terminal', () => {
    const bundles = new TurnBundleBuilder().build({
      sessionId: 'session_1',
      jobs: [job({ id: 'job_1', status: 'running' })],
      groups: [single(message('goal', 1, 'job_1', 'user'))],
    });
    expect(bundles[0]?.terminal).toBe(false);
  });
});

function single(message_: AgentMessage): MessageGroup {
  return { id: `message:${message_.id}`, type: 'single', messages: [message_] };
}

function job(overrides: Partial<AgentJob> & Pick<AgentJob, 'id'>): AgentJob {
  return {
    sessionId: 'session_1', status: 'completed', attemptNo: 1,
    version: 1, createdAtMs: overrides.id === 'job_root' ? 1 : 2, updatedAtMs: 2,
    ...overrides,
  };
}

function message(
  id: string,
  rowId: number,
  jobId: string,
  role: 'user' | 'assistant'
): AgentMessage {
  return {
    id, rowId, sessionId: 'session_1', jobId, role,
    messageType: role === 'user' ? 'user_message' : 'assistant_message',
    visibility: 'ui', channel: role === 'assistant' ? 'final' : 'normal', content: id,
    createdAtMs: rowId,
  };
}
