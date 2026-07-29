import { describe, expect, it } from 'vitest';
import {
  AGENT_REQUEST_LIMITS,
  ACTIVE_TASK_STATUSES,
  AGENT_TASK_RUN_STATUSES,
  AGENT_TASK_RUN_TRIGGERS,
  AGENT_TASK_STATUSES,
  AGENT_TOOL_CALL_STATUSES,
  AGENT_USER_INPUT_REQUEST_KINDS,
  isTerminalTaskStatus,
  resolveTaskGoalMessage,
  validateAgentUserInputAnswer,
  validateAgentUserInputSchema,
  type AgentMessage,
} from '../src/domain/index.js';

describe('durable domain vocabulary', () => {
  it('exposes only the converged Task and execution states', () => {
    expect(AGENT_TASK_STATUSES).toEqual([
      'created', 'running', 'waiting_for_user',
      'completed', 'failed', 'cancelled',
    ]);
    expect(ACTIVE_TASK_STATUSES).toEqual([
      'created', 'running', 'waiting_for_user',
    ]);
    expect(AGENT_TASK_RUN_TRIGGERS).toEqual([
      'initial', 'user_input_answered',
    ]);
    expect(AGENT_TASK_RUN_STATUSES).toEqual([
      'running', 'paused', 'completed', 'failed', 'interrupted', 'cancelled',
    ]);
    expect(AGENT_TOOL_CALL_STATUSES).toEqual([
      'pending', 'running', 'waiting_for_user', 'completed', 'failed',
      'outcome_unknown', 'cancelled',
    ]);
    expect(AGENT_USER_INPUT_REQUEST_KINDS).toEqual(['tool_input']);
    expect(isTerminalTaskStatus('completed')).toBe(true);
    expect(isTerminalTaskStatus('waiting_for_user')).toBe(false);
  });

  it('resolves a Task goal by immutable message identity, not timeline position', () => {
    const messages = [
      message({ id: 'message_other', content: 'later message' }),
      message({ id: 'message_goal', content: 'original goal' }),
    ];
    expect(resolveTaskGoalMessage({ goalMessageId: 'message_goal' }, messages)?.content)
      .toBe('original goal');
  });

  it('validates HITL answers against the persisted input contract', () => {
    expect(validateAgentUserInputAnswer(
      { type: 'text', maxLength: 3 },
      'four'
    )).toMatchObject({ valid: false });
    expect(validateAgentUserInputAnswer(
      { type: 'single_choice', options: [{ label: 'One', value: 'one' }] },
      'two'
    )).toMatchObject({ valid: false });
    expect(validateAgentUserInputAnswer(
      {
        type: 'multi_choice',
        min: 1,
        max: 2,
        options: [
          { label: 'One', value: 'one' },
          { label: 'Two', value: 'two' },
        ],
      },
      ['one', 'one']
    )).toMatchObject({ valid: false });
    expect(validateAgentUserInputAnswer(
      {
        type: 'multi_choice',
        min: 1,
        max: 2,
        options: [
          { label: 'One', value: 'one' },
          { label: 'Two', value: 'two' },
        ],
      },
      ['one', 'two']
    )).toEqual({ valid: true });
  });

  it('rejects HITL schemas that cannot produce a valid answer', () => {
    expect(validateAgentUserInputSchema({
      type: 'text',
      defaultValue: 'long',
      maxLength: 3,
    })).toMatchObject({ valid: false });
    expect(validateAgentUserInputSchema({
      type: 'single_choice',
      options: [
        { label: 'One', value: 'same' },
        { label: 'Again', value: 'same' },
      ],
    })).toMatchObject({ valid: false });
    expect(validateAgentUserInputSchema({
      type: 'multi_choice',
      min: 2,
      max: 1,
      options: [{ label: 'One', value: 'one' }],
    })).toMatchObject({ valid: false });
    expect(validateAgentUserInputSchema({
      type: 'text',
      maxLength: AGENT_REQUEST_LIMITS.userInputTextCharacters + 1,
    })).toMatchObject({ valid: false });
    expect(validateAgentUserInputAnswer(
      { type: 'text' },
      'x'.repeat(AGENT_REQUEST_LIMITS.userInputTextCharacters + 1)
    )).toMatchObject({ valid: false });
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
