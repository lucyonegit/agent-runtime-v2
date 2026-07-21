import { describe, expect, it } from 'vitest';
import {
  ACTIVE_JOB_STATUSES,
  AGENT_CONTEXT_OWNER_TYPES,
  AGENT_CONTEXT_PURPOSES,
  AGENT_MESSAGE_CHANNELS,
  AGENT_MODEL_CALL_TYPES,
  AGENT_REALTIME_ENTITY_EVENT_TYPES,
  AGENT_TOOL_INVOCATION_STATUSES,
  canTransitionJob,
  isValidAnswerModeForSource,
  isTerminalJobStatus,
} from '../src/domain/index.js';

describe('canonical runtime domain', () => {
  it('treats failed jobs as terminal and requires a new retry job', () => {
    expect(isTerminalJobStatus('failed')).toBe(true);
    expect(canTransitionJob('failed', 'resuming')).toBe(false);
  });

  it('allows waiting jobs to resume execution', () => {
    expect(canTransitionJob('waiting_user_input', 'resuming')).toBe(true);
    expect(canTransitionJob('resuming', 'running')).toBe(true);
  });

  it('requires an explicit resume after an interrupted execution is paused', () => {
    expect(canTransitionJob('running', 'recovery_required')).toBe(true);
    expect(canTransitionJob('recovery_required', 'running')).toBe(true);
    expect(isTerminalJobStatus('recovery_required')).toBe(false);
  });

  it('defines database-active statuses consistently', () => {
    expect(ACTIVE_JOB_STATUSES).toEqual([
      'created',
      'running',
      'waiting_user_input',
      'resuming',
      'recovery_required',
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

  it('uses the final context owner and purpose dictionaries', () => {
    expect(AGENT_CONTEXT_OWNER_TYPES).toEqual(['session', 'job']);
    expect(AGENT_CONTEXT_PURPOSES).toEqual([
      'conversation',
      'job_execution',
    ]);
  });

  it('uses stable model-call and realtime event dictionaries', () => {
    expect(AGENT_MODEL_CALL_TYPES).toEqual(['job.react', 'context.compress']);
    expect(AGENT_MODEL_CALL_TYPES).toContain('context.compress');
    expect(AGENT_MODEL_CALL_TYPES).not.toContain('code.react');
    expect(AGENT_REALTIME_ENTITY_EVENT_TYPES).toEqual([
      'message.upserted',
      'job.upserted',
      'plan.upserted',
      'plan_step.upserted',
      'tool_invocation.upserted',
      'user_input.upserted',
      'model_usage.updated',
      'artifact.upserted',
    ]);
  });
});
