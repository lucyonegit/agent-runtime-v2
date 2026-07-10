import type { AgentToolCall } from '../domain/index.js';
import type { LoopFailureCode } from './loop-result.js';
import type { ModelToolCallChunk } from './model-port.js';

interface AccumulatedToolCall {
  index: number;
  id?: string;
  name?: string;
  argumentsJson: string;
  conflict?: string;
}

export interface ToolCallAssemblyError {
  code: Extract<LoopFailureCode, 'invalid_tool_arguments' | 'model_error'>;
  call: AgentToolCall;
  message: string;
  details: { index: number; reason: string };
}

export interface ToolCallAssemblyResult {
  toolCalls: AgentToolCall[];
  errors: ToolCallAssemblyError[];
}

export class ToolCallAssembler {
  readonly #calls = new Map<number, AccumulatedToolCall>();

  add(chunks: ModelToolCallChunk[]): void {
    for (const chunk of chunks) {
      const index = chunk.index ?? 0;
      const current = this.#calls.get(index) ?? { index, argumentsJson: '' };
      current.id = mergeStableField(current.id, chunk.id, 'id', current);
      current.name = mergeStableField(current.name, chunk.name, 'name', current);
      if (chunk.args) current.argumentsJson += chunk.args;
      this.#calls.set(index, current);
    }
  }

  finish(fallbackId: (index: number) => string): ToolCallAssemblyResult {
    const toolCalls: AgentToolCall[] = [];
    const errors: ToolCallAssemblyError[] = [];
    for (const accumulated of [...this.#calls.values()].sort((left, right) => left.index - right.index)) {
      const call: AgentToolCall = {
        id: accumulated.id || fallbackId(accumulated.index),
        name: accumulated.name || `invalid_tool_${accumulated.index}`,
        args: {},
      };
      if (accumulated.conflict) {
        toolCalls.push(call);
        errors.push({
          code: 'model_error',
          call,
          message: `Conflicting streamed tool-call fields at index ${accumulated.index}.`,
          details: { index: accumulated.index, reason: accumulated.conflict },
        });
        continue;
      }
      if (!accumulated.name) {
        toolCalls.push(call);
        errors.push({
          code: 'invalid_tool_arguments',
          call,
          message: `Streamed tool call at index ${accumulated.index} has no name.`,
          details: { index: accumulated.index, reason: 'missing_name' },
        });
        continue;
      }

      try {
        const parsed = accumulated.argumentsJson.trim()
          ? JSON.parse(accumulated.argumentsJson)
          : {};
        if (!isRecord(parsed)) {
          throw new TypeError('tool arguments must be a JSON object');
        }
        call.args = parsed;
        toolCalls.push(call);
      } catch {
        toolCalls.push(call);
        errors.push({
          code: 'invalid_tool_arguments',
          call,
          message: `Tool ${JSON.stringify(call.name)} returned invalid JSON object arguments.`,
          details: { index: accumulated.index, reason: 'invalid_json_object' },
        });
      }
    }
    return { toolCalls, errors };
  }
}

function mergeStableField(
  current: string | undefined,
  incoming: string | undefined,
  field: 'id' | 'name',
  call: AccumulatedToolCall
): string | undefined {
  if (!incoming) return current;
  if (!current || current === incoming) return incoming;
  call.conflict = `conflicting_${field}`;
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
