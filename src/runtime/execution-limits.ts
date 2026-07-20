export interface ExecutionLimits {
  maxIterations: number;
  maxToolCalls: number;
  executionDeadlineMs: number;
  jobLeaseMs: number;
  jobHeartbeatMs: number;
}

const DEFAULT_EXECUTION_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  maxIterations: 24,
  maxToolCalls: 48,
  executionDeadlineMs: 15 * 60_000,
  jobLeaseMs: 30_000,
  jobHeartbeatMs: 10_000,
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
