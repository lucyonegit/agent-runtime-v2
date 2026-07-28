import { createHash } from 'node:crypto';
import { stableStringify } from '../../helpers/stable-json.helper.js';

export function checksumToolArguments(arguments_: Record<string, unknown>): string {
  return sha256(stableStringify(arguments_));
}

export function createToolIdempotencyKey(taskId: string, modelToolCallId: string): string {
  return sha256(`${taskId}:${modelToolCallId}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
