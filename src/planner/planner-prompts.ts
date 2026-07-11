export const PLANNER_ROUTE_PROMPT_VERSION = 'planner-route-v1';
export const PLANNER_CREATE_PROMPT_VERSION = 'planner-create-v1';
export const STEP_OUTPUT_PROMPT_VERSION = 'step-output-v1';
export const PLAN_FINAL_PROMPT_VERSION = 'plan-final-v1';

export const STEP_OUTPUT_INSTRUCTION = `When the current PlanStep is complete, return only one
JSON object with exactly this StepOutputV1 shape:
{"schemaVersion":1,"summary":"non-empty result summary","artifacts":[],"evidence":[],"unresolved":[]}
Do not return the user-facing final answer, prose outside the JSON object, or markdown fences.
Populate artifacts and evidence only when the Step produced durable references that can be cited.`;

export const STEP_OUTPUT_REPAIR_INSTRUCTION = `Convert the supplied raw model output into valid
StepOutputV1 JSON. Return only one JSON object with exactly these required fields:
{"schemaVersion":1,"summary":"non-empty result summary","artifacts":[],"evidence":[],"unresolved":[]}
Preserve the raw result in summary. Do not echo the repair request, use wrapper fields such as
rawOutput/value, add prose, or return markdown fences.`;
