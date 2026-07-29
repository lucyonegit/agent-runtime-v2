/** Terminal outcome returned by the storage-independent ReAct loop. */
export type LoopFailureCode =
  | 'empty_model_output'
  | 'max_iterations'
  | 'max_tool_calls'
  | 'deadline_exceeded'
  | 'invalid_tool_arguments'
  | 'context_build_error'
  | 'model_protocol_error'
  | 'invalid_plan_state'
  | 'tool_state_unknown'
  | 'model_error'
  | 'model_output_truncated'
  | 'model_input_too_large';

export type LoopResult =
  | {
      type: 'completed';
      outputId: string;
      content: string;
    }
  | {
      type: 'waiting_for_user';
      modelToolCallIds: string[];
    }
  | {
      type: 'failed';
      code: LoopFailureCode;
      message: string;
      details?: unknown;
    }
  | {
      type: 'cancelled';
      reason?: 'runtime_shutdown' | 'ownership_lost';
    };
