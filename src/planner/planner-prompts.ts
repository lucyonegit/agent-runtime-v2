export const PLANNER_ROUTE_PROMPT_VERSION = 'planner-route-v2';
export const PLANNER_CREATE_PROMPT_VERSION = 'planner-create-v1';
export const STEP_OUTPUT_PROMPT_VERSION = 'step-output-v1';
export const PLAN_FINAL_PROMPT_VERSION = 'plan-final-v1';

export const STEP_OUTPUT_INSTRUCTION = `When the current PlanStep is complete, return only one
JSON object with exactly this StepOutputV1 shape:
{"schemaVersion":1,"summary":"non-empty result summary","artifacts":[{"type":"file|url|record|text","ref":"durable reference","label":"optional label","checksum":"optional checksum"}],"evidence":[{"claim":"supported claim","sourceMessageIds":["message-id"],"sourceUrls":["https://optional.example/source"]}],"unresolved":[{"description":"open issue","impact":"low|medium|high","recommendedAction":"optional next action"}]}
Do not return the user-facing final answer, prose outside the JSON object, or markdown fences.
Use an empty array for artifacts, evidence, or unresolved when that category has no entries.
Populate artifacts and evidence only when the Step produced durable references that can be cited.`;

export const STEP_OUTPUT_REPAIR_INSTRUCTION = `Convert the supplied raw model output into valid
StepOutputV1 JSON. Return only one JSON object with exactly these required fields:
{"schemaVersion":1,"summary":"non-empty result summary","artifacts":[{"type":"file|url|record|text","ref":"durable reference","label":"optional label","checksum":"optional checksum"}],"evidence":[{"claim":"supported claim","sourceMessageIds":["message-id"],"sourceUrls":["https://optional.example/source"]}],"unresolved":[{"description":"open issue","impact":"low|medium|high","recommendedAction":"optional next action"}]}
Use an empty array for a category with no entries. Every unresolved item must include description
and impact; impact must be exactly low, medium, or high. Remove unsupported fields.
Preserve the raw result in summary. Do not echo the repair request, use wrapper fields such as
rawOutput/value, add prose, or return markdown fences.`;
