import { DEFAULT_EXECUTION_CONFIG } from '../../config/execution-config.js';

/** Limits shared by Job ownership and the inner ReAct execution loop. */
export interface ExecutionLimits {
  maxIterations: number;
  maxToolCalls: number;
  executionDeadlineMs: number;
  jobLeaseMs: number;
  jobHeartbeatMs: number;
}

const DEFAULT_EXECUTION_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  maxIterations: DEFAULT_EXECUTION_CONFIG.maxIterations,
  maxToolCalls: DEFAULT_EXECUTION_CONFIG.maxToolCalls,
  executionDeadlineMs: DEFAULT_EXECUTION_CONFIG.deadlineMs,
  jobLeaseMs: DEFAULT_EXECUTION_CONFIG.ownershipTimeoutMs,
  jobHeartbeatMs: DEFAULT_EXECUTION_CONFIG.ownershipRefreshMs,
});

export function resolveExecutionLimits(
  overrides: Partial<ExecutionLimits> = {}
): ExecutionLimits {
  const limits = { ...DEFAULT_EXECUTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
  if (limits.jobHeartbeatMs >= limits.jobLeaseMs) {
    throw new RangeError('jobHeartbeatMs must be shorter than jobLeaseMs.');
  }
  return limits;
}
