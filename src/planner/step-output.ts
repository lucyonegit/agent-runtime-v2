export interface StepOutputV1 {
  schemaVersion: 1;
  summary: string;
  artifacts: Array<{
    type: 'file' | 'url' | 'record' | 'text';
    ref: string;
    label?: string;
    checksum?: string;
  }>;
  evidence: Array<{
    claim: string;
    sourceMessageIds: string[];
    sourceUrls?: string[];
  }>;
  unresolved: Array<{
    description: string;
    impact: 'low' | 'medium' | 'high';
    recommendedAction?: string;
  }>;
}

export class StepOutputValidationError extends Error {
  readonly code = 'invalid_step_output';
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid StepOutputV1: ${issues.join('; ')}`);
    this.name = 'StepOutputValidationError';
    this.issues = issues;
  }
}

export function parseStepOutput(value: string | unknown): StepOutputV1 {
  let candidate: unknown = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(stripJsonFence(value));
    } catch {
      throw new StepOutputValidationError(['output must be valid JSON']);
    }
  }
  const issues = validateStepOutput(candidate);
  if (issues.length > 0) throw new StepOutputValidationError(issues);
  return candidate as StepOutputV1;
}

export function validateStepOutput(value: unknown): string[] {
  if (!isRecord(value)) return ['output must be an object'];
  const issues: string[] = [];
  if (value.schemaVersion !== 1) issues.push('schemaVersion must equal 1');
  if (typeof value.summary !== 'string' || !value.summary.trim()) {
    issues.push('summary must be non-empty');
  } else if (value.summary.length > 8_000) {
    issues.push('summary must not exceed 8000 characters');
  }
  if (!Array.isArray(value.artifacts)) {
    issues.push('artifacts must be an array');
  } else {
    value.artifacts.forEach((artifact, index) => {
      if (!isRecord(artifact)) return issues.push(`artifacts[${index}] must be an object`);
      if (!['file', 'url', 'record', 'text'].includes(String(artifact.type))) {
        issues.push(`artifacts[${index}].type is invalid`);
      }
      if (typeof artifact.ref !== 'string' || !artifact.ref.trim()) {
        issues.push(`artifacts[${index}].ref must be non-empty`);
      }
    });
  }
  if (!Array.isArray(value.evidence)) {
    issues.push('evidence must be an array');
  } else {
    value.evidence.forEach((evidence, index) => {
      if (!isRecord(evidence)) return issues.push(`evidence[${index}] must be an object`);
      if (typeof evidence.claim !== 'string' || !evidence.claim.trim()) {
        issues.push(`evidence[${index}].claim must be non-empty`);
      }
      if (!Array.isArray(evidence.sourceMessageIds)
        || evidence.sourceMessageIds.some(id => typeof id !== 'string' || !id)) {
        issues.push(`evidence[${index}].sourceMessageIds must be a string array`);
      }
    });
  }
  if (!Array.isArray(value.unresolved)) {
    issues.push('unresolved must be an array');
  } else {
    value.unresolved.forEach((unresolved, index) => {
      if (!isRecord(unresolved)) return issues.push(`unresolved[${index}] must be an object`);
      if (typeof unresolved.description !== 'string' || !unresolved.description.trim()) {
        issues.push(`unresolved[${index}].description must be non-empty`);
      }
      if (!['low', 'medium', 'high'].includes(String(unresolved.impact))) {
        issues.push(`unresolved[${index}].impact is invalid`);
      }
    });
  }
  return issues;
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
