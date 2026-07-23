import { AgentStoreError } from '../storage/agent-store.js';

export type RuntimeErrorCode =
  | 'empty_model_output'
  | 'max_iterations'
  | 'max_tool_calls'
  | 'deadline_exceeded'
  | 'aborted'
  | 'model_error'
  | 'model_output_truncated'
  | 'invalid_tool_arguments'
  | 'tool_not_found'
  | 'tool_failed'
  | 'tool_state_unknown'
  | 'context_overflow'
  | 'invalid_job_state'
  | 'invalid_plan_state'
  | 'idempotency_conflict'
  | 'concurrency_conflict'
  | 'lease_lost'
  | 'storage_error';

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'RuntimeError';
    this.code = code;
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.details = options.details;
  }
}

export function mapStoreError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (!(error instanceof AgentStoreError)) {
    return new RuntimeError('storage_error', 'Agent Runtime storage operation failed.', {
      retryable: true,
      cause: error,
    });
  }

  switch (error.code) {
    case 'CONCURRENCY_CONFLICT':
    case 'ACTIVE_JOB_CONFLICT':
      return new RuntimeError('concurrency_conflict', error.message, {
        details: error.details,
        cause: error,
      });
    case 'JOB_LEASE_LOST':
      return new RuntimeError('lease_lost', error.message, {
        details: error.details,
        cause: error,
      });
    case 'INVALID_JOB_STATE':
    case 'INVALID_JOB_RETRY':
    case 'INVALID_USER_INPUT_STATE':
    case 'USER_INPUT_REQUEST_NOT_FOUND':
      return new RuntimeError('invalid_job_state', error.message, {
        details: error.details,
        cause: error,
      });
    case 'INVALID_PLAN_STATE':
    case 'PLAN_NOT_FOUND':
    case 'PLAN_STEP_NOT_FOUND':
      return new RuntimeError('invalid_plan_state', error.message, {
        retryable: false,
        details: error.details,
        cause: error,
      });
    case 'USER_INPUT_ANSWER_CONFLICT':
      return new RuntimeError('idempotency_conflict', error.message, {
        details: error.details,
        cause: error,
      });
    default:
      return new RuntimeError('storage_error', error.message, {
        retryable: false,
        details: error.details,
        cause: error,
      });
  }
}

function defaultRetryable(code: RuntimeErrorCode): boolean {
  return code === 'model_error'
    || code === 'model_output_truncated'
    || code === 'storage_error';
}
