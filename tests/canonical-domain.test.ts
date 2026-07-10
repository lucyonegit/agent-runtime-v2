import { describe, expect, it } from 'vitest';
import {
  ACTIVE_JOB_STATUSES,
  ACTIVE_STEP_RUN_STATUSES,
  canTransitionJob,
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
});
