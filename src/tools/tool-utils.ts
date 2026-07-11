import type { RunnableConfig } from '@langchain/core/runnables';
import type { RuntimeToolContext } from '../runtime/tool-executor.js';

export function runtimeContext(config?: RunnableConfig): RuntimeToolContext {
  const context = config?.configurable?.agentRuntimeContext;
  if (!context || typeof context !== 'object') {
    throw new Error('Runtime tool context is unavailable.');
  }
  return context as RuntimeToolContext;
}

export function jsonToolOutput(result: unknown): [string, unknown] {
  return [JSON.stringify(result), result];
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
