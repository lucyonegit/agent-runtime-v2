import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TASK_STATUSES,
  AGENT_TASK_RUN_STATUSES,
  AGENT_TASK_RUN_TRIGGERS,
  AGENT_TASK_STATUSES,
  AGENT_TOOL_CALL_STATUSES,
  AGENT_TOOL_RUN_STATUSES,
  isTerminalTaskStatus,
  resolveTaskGoalMessage,
  type AgentMessage,
} from '../src/domain/index.js';

describe('durable domain vocabulary', () => {
  it('exposes only the converged Task and execution states', () => {
    expect(AGENT_TASK_STATUSES).toEqual([
      'created', 'running', 'waiting_for_user', 'recovery_required',
      'completed', 'failed', 'cancelled',
    ]);
    expect(ACTIVE_TASK_STATUSES).toEqual([
      'created', 'running', 'waiting_for_user', 'recovery_required',
    ]);
    expect(AGENT_TASK_RUN_TRIGGERS).toEqual([
      'initial', 'user_input_answered', 'input_expired', 'manual_resume',
    ]);
    expect(AGENT_TASK_RUN_STATUSES).toEqual([
      'running', 'paused', 'completed', 'failed', 'interrupted', 'cancelled',
    ]);
    expect(AGENT_TOOL_CALL_STATUSES).toEqual([
      'pending', 'running', 'waiting_for_user', 'completed', 'failed',
      'outcome_unknown', 'cancelled',
    ]);
    expect(AGENT_TOOL_RUN_STATUSES).toEqual([
      'running', 'completed', 'failed', 'interrupted', 'outcome_unknown', 'cancelled',
    ]);
    expect(isTerminalTaskStatus('completed')).toBe(true);
    expect(isTerminalTaskStatus('recovery_required')).toBe(false);
  });

  it('resolves a Task goal by immutable message identity, not timeline position', () => {
    const messages = [
      message({ id: 'message_other', content: 'later message' }),
      message({ id: 'message_goal', content: 'original goal' }),
    ];
    expect(resolveTaskGoalMessage({ goalMessageId: 'message_goal' }, messages)?.content)
      .toBe('original goal');
  });
});

function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'content'>): AgentMessage {
  return {
    rowId: overrides.id === 'message_goal' ? 1 : 2,
    sessionId: 'session_1',
    taskId: 'task_1',
    role: 'user',
    messageType: 'user_message',
    contextScope: 'conversation',
    visibility: 'ui',
    channel: 'normal',
    createdAtMs: 1,
    ...overrides,
  };
}
