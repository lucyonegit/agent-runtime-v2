export type LoopFailureCode =
  | 'empty_model_output'
  | 'max_iterations'
  | 'max_tool_calls'
  | 'deadline_exceeded'
  | 'invalid_tool_arguments'
  | 'context_build_error'
  | 'model_protocol_error'
  | 'invalid_plan_state'
  | 'model_error'
  | 'context_overflow';

export type LoopResult =
  | {
      type: 'completed';
      outputId: string;
      content: string;
    }
  | {
      type: 'waiting_user_input';
      toolCallIds: string[];
    }
  | {
      type: 'failed';
      code: LoopFailureCode;
      message: string;
      details?: unknown;
    }
  | { type: 'cancelled' };
