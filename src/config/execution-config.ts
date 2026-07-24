export interface ExecutionConfig {
  maxIterations: number;
  maxToolCalls: number;
  deadlineMs: number;
  ownershipTimeoutMs: number;
  ownershipRefreshMs: number;
  recoveryScanIntervalMs: number;
  recoveryBatchSize: number;
}

export const DEFAULT_EXECUTION_CONFIG: Readonly<ExecutionConfig> = Object.freeze({
  maxIterations: 24,
  maxToolCalls: 48,
  deadlineMs: 15 * 60_000,
  ownershipTimeoutMs: 30_000,
  ownershipRefreshMs: 10_000,
  recoveryScanIntervalMs: 5_000,
  recoveryBatchSize: 32,
});
