import { createHash } from 'node:crypto';

export function checksumToolArguments(arguments_: Record<string, unknown>): string {
  return sha256(canonicalJson(arguments_));
}

export function createToolIdempotencyKey(jobId: string, toolCallId: string): string {
  return sha256(`${jobId}:${toolCallId}`);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
