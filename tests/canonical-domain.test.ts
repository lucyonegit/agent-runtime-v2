import { describe, expect, it } from 'vitest';
import {
  ACTIVE_JOB_STATUSES,
  ACTIVE_STEP_RUN_STATUSES,
  AGENT_MESSAGE_CHANNELS,
  AGENT_TOOL_INVOCATION_STATUSES,
  canTransitionJob,
  isValidAnswerModeForSource,
  isTerminalJobStatus,
} from '../src/domain/canonical/index.js';

describe('canonical runtime domain', () => {
  it('treats failed jobs as terminal and requires a new retry job', () => {
    expect(isTerminalJobStatus('failed')).toBe(true);
    expect(canTransitionJob('failed', 'resuming')).toBe(false);
  });

  it('allows waiting jobs to be claimed for resume', () => {
    expect(canTransitionJob('waiting_user_input', 'resuming')).toBe(true);
    expect(canTransitionJob('resuming', 'running')).toBe(true);
  });

  it('defines database-active statuses consistently', () => {
    expect(ACTIVE_JOB_STATUSES).toEqual([
      'created',
      'running',
      'waiting_user_input',
      'resuming',
    ]);
    expect(ACTIVE_STEP_RUN_STATUSES).toEqual([
      'created',
      'running',
      'waiting_user_input',
      'resuming',
    ]);
  });

  it('does not expose private reasoning as a persisted message channel', () => {
    expect(AGENT_MESSAGE_CHANNELS).toEqual(['normal', 'progress', 'final']);
    expect(AGENT_MESSAGE_CHANNELS).not.toContain('thought');
  });

  it('tracks each tool invocation independently', () => {
    expect(AGENT_TOOL_INVOCATION_STATUSES).toEqual([
      'pending',
      'running',
      'waiting_user_input',
      'completed',
      'failed',
      'unknown',
      'cancelled',
    ]);
  });

  it('requires tool-origin answers to preserve the tool protocol', () => {
    expect(isValidAnswerModeForSource('tool', 'as_tool_result')).toBe(true);
    expect(isValidAnswerModeForSource('tool', 'as_user_message')).toBe(false);
    expect(isValidAnswerModeForSource('agent', 'as_user_message')).toBe(true);
  });
});
