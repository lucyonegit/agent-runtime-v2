import { AgentStoreError } from '../../storage/agent-store.js';

export type RuntimeErrorCode =
  | 'empty_model_output'
  | 'max_iterations'
  | 'max_tool_calls'
  | 'deadline_exceeded'
  | 'execution_stop_timeout'
  | 'aborted'
  | 'model_error'
  | 'model_output_truncated'
  | 'invalid_tool_arguments'
  | 'tool_not_found'
  | 'tool_failed'
  | 'tool_state_unknown'
  | 'model_input_too_large'
  | 'invalid_session_state'
  | 'invalid_task_state'
  | 'invalid_user_input'
  | 'invalid_plan_state'
  | 'idempotency_conflict'
  | 'concurrency_conflict'
  | 'ownership_lost'
  | 'storage_error';

export class RuntimeError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'RuntimeError';
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.details = options.details;
  }
  readonly details?: Record<string, unknown>;
}

export function mapStoreError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (!(error instanceof AgentStoreError)) {
    return new RuntimeError('storage_error', 'Agent Runtime storage operation failed.', {
      retryable: true,
      cause: error,
    });
  }
  const options = { details: error.details, cause: error };
  switch (error.code) {
    case 'CONCURRENCY_CONFLICT':
    case 'ACTIVE_TASK_CONFLICT':
      return new RuntimeError('concurrency_conflict', error.message, options);
    case 'TASK_OWNERSHIP_LOST':
      return new RuntimeError('ownership_lost', error.message, options);
    case 'INVALID_SESSION_STATE':
      return new RuntimeError('invalid_session_state', error.message, { ...options, retryable: false });
    case 'INVALID_TASK_STATE':
    case 'TASK_NOT_FOUND':
    case 'TASK_RUN_NOT_FOUND':
    case 'INVALID_USER_INPUT_STATE':
    case 'USER_INPUT_REQUEST_NOT_FOUND':
      return new RuntimeError('invalid_task_state', error.message, options);
    case 'INVALID_USER_INPUT_ANSWER':
      return new RuntimeError('invalid_user_input', error.message, { ...options, retryable: false });
    case 'ACTIVE_PLAN_NOT_FOUND':
      return new RuntimeError('invalid_plan_state', error.message, { ...options, retryable: false });
    case 'CLIENT_REQUEST_CONFLICT':
    case 'USER_INPUT_ANSWER_CONFLICT':
      return new RuntimeError('idempotency_conflict', error.message, options);
    default:
      return new RuntimeError('storage_error', error.message, { ...options, retryable: false });
  }
}

function defaultRetryable(code: RuntimeErrorCode): boolean {
  return code === 'model_error'
    || code === 'model_output_truncated'
    || code === 'execution_stop_timeout'
    || code === 'storage_error';
}
