import type { ReactCoreTool } from '../core/index.js';

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface RuntimeTool extends ReactCoreTool {
  description: string;
  parameters: JsonSchemaObject;
}

export function completed(content: string, result?: unknown) {
  return {
    type: 'completed' as const,
    content,
    result,
  };
}

export function completedJson(result: unknown) {
  return completed(JSON.stringify(result), result);
}

export function failed(error: string, details?: unknown) {
  return {
    type: 'failed' as const,
    error,
    details,
  };
}

export function stringArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

export function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
