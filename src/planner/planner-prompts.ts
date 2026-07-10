export const PLANNER_ROUTE_PROMPT_VERSION = 'planner-route-v1';
export const PLANNER_CREATE_PROMPT_VERSION = 'planner-create-v1';
export const STEP_OUTPUT_PROMPT_VERSION = 'step-output-v1';
export const PLAN_FINAL_PROMPT_VERSION = 'plan-final-v1';

export const STEP_OUTPUT_INSTRUCTION = `Return only StepOutputV1 JSON with schemaVersion=1,
non-empty summary, artifacts[], evidence[], and unresolved[]. Do not return markdown fences.`;
