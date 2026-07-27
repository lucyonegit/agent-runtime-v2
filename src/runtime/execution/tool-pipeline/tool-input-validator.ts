import type { ToolExecutionResult } from '../../loop/agent-loop.js';
import { estimateTextTokens } from '../../context/helpers/token-budget.helper.js';
import type { RuntimeToolArgumentLimit } from '../tool-executor.js';

export function validateToolInput(
  arguments_: Record<string, unknown>,
  limits: RuntimeToolArgumentLimit[] | undefined
): Extract<ToolExecutionResult, { type: 'failed' }> | undefined {
  for (const limit of limits ?? []) {
    const value = readArgumentPath(arguments_, limit.path);
    if (typeof value !== 'string') continue;
    const estimatedTokens = estimateTextTokens(value);
    if (
      (limit.maxCharacters !== undefined && value.length > limit.maxCharacters)
      || (limit.maxEstimatedTokens !== undefined && estimatedTokens > limit.maxEstimatedTokens)
    ) {
      return {
        type: 'failed',
        code: limit.errorCode,
        message: limit.message,
        details: {
          argumentPath: limit.path,
          characters: value.length,
          estimatedTokens,
          maxCharacters: limit.maxCharacters,
          maxEstimatedTokens: limit.maxEstimatedTokens,
        },
      };
    }
  }
  return undefined;
}

function readArgumentPath(arguments_: Record<string, unknown>, path: string): unknown {
  let current: unknown = arguments_;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
