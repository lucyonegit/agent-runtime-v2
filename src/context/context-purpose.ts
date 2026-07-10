export const CONTEXT_PURPOSES = [
  'conversation',
  'job_execution',
  'step_execution',
  'plan_final',
  'code_execution',
  'context_compression',
] as const;

export type ContextPurpose = typeof CONTEXT_PURPOSES[number];

export const CONTEXT_RULES_VERSION = 'job-step-run-context-v1';
