import type { RunnableConfig } from '@langchain/core/runnables';
import type { RuntimeToolContext } from '../../runtime/execution/tool-executor.js';

export function runtimeContext(config?: RunnableConfig): RuntimeToolContext {
  const context = config?.configurable?.agentRuntimeContext;
  if (!context || typeof context !== 'object') {
    throw new Error('Runtime tool context is unavailable.');
  }
  return context as RuntimeToolContext;
}

export function jsonToolOutput(result: unknown): [string, unknown] {
  const safeResult = sanitizeJsonValue(result);
  return [JSON.stringify(safeResult), safeResult];
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key.replaceAll('\u0000', ''),
    sanitizeJsonValue(child),
  ]));
}

export function stringArgument(
  input: Record<string, unknown>,
  key: string,
  fallback = ''
): string {
  const value = input[key];
  return typeof value === 'string' ? value : fallback;
}

export function numberArgument(
  input: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
