export const CONTEXT_PURPOSES = [
  'conversation',
  'job_execution',
  'step_execution',
  'plan_final',
  'code_execution',
  'context_compression',
] as const;

export type ContextPurpose = typeof CONTEXT_PURPOSES[number];

export type ContextScope =
  | { kind: 'session_history' }
  | { kind: 'job'; jobId: string; originalGoal: string; originalGoalMessageId?: string }
  | {
      kind: 'step_run';
      jobId: string;
      stepRunId: string;
      originalGoal: string;
      originalGoalMessageId?: string;
    };

export const CONTEXT_RULES_VERSION = 'job-step-run-context-v4';
