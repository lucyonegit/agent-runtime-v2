import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RuntimeTool } from '../../runtime/execution/tool-executor.js';
import { jsonToolOutput, stringArgument } from '../helpers/tool-input.helper.js';

export function createBasicTools(): RuntimeTool[] {
  const getCurrentTime = new DynamicStructuredTool({
    name: 'get_current_time',
    description: 'Get the current date and time. When the user omits a time zone, call this tool without asking; it defaults to Asia/Shanghai.',
    schema: {
      type: 'object',
      properties: {
        timeZone: {
          type: 'string',
          description: 'IANA time zone, for example Asia/Shanghai. Omit it to use Asia/Shanghai.',
        },
      },
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async input => {
      const timeZone = stringArgument(input as Record<string, unknown>, 'timeZone', 'Asia/Shanghai');
      const now = new Date();
      const value = new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'full',
        timeStyle: 'medium',
        timeZone,
      }).format(now);
      return jsonToolOutput({ iso: now.toISOString(), timeZone, value });
    },
  });

  const calculate = new DynamicStructuredTool({
    name: 'calculate',
    description: 'Evaluate a simple numeric expression.',
    schema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Numeric expression using numbers, +, -, *, /, %, parentheses and spaces.',
        },
      },
      required: ['expression'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async input => {
      const expression = stringArgument(input as Record<string, unknown>, 'expression');
      if (!/^[\d\s+\-*/().%]+$/.test(expression)) {
        throw new Error('Only simple numeric expressions are allowed.');
      }
      const result = Function(`"use strict"; return (${expression});`)() as unknown;
      if (typeof result !== 'number' || !Number.isFinite(result)) {
        throw new Error('Calculation did not produce a finite number.');
      }
      return jsonToolOutput({ expression, result });
    },
  });

  return [
    { tool: getCurrentTime, sideEffectLevel: 'read_only' },
    { tool: calculate, sideEffectLevel: 'read_only' },
  ];
}
