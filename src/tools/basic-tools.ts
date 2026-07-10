import type { RuntimeTool } from './types.js';
import { completedJson, failed, stringArg } from './types.js';

export function createBasicTools(): RuntimeTool[] {
  return [
    {
      name: 'get_current_time',
      description: 'Get the current date and time for an IANA time zone.',
      parameters: {
        type: 'object',
        properties: {
          timeZone: {
            type: 'string',
            description: 'IANA timezone, for example Asia/Shanghai.',
          },
        },
        additionalProperties: false,
      },
      execute: async args => {
        const timeZone = stringArg(args, 'timeZone', 'Asia/Shanghai');
        const now = new Date();
        try {
          const value = new Intl.DateTimeFormat('zh-CN', {
            dateStyle: 'full',
            timeStyle: 'medium',
            timeZone,
          }).format(now);
          return completedJson({ iso: now.toISOString(), timeZone, value });
        } catch (error) {
          return failed(`Invalid time zone: ${timeZone}`, {
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'calculate',
      description: 'Evaluate a simple numeric expression.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Simple numeric expression using numbers, +, -, *, /, %, parentheses and spaces.',
          },
        },
        required: ['expression'],
        additionalProperties: false,
      },
      execute: async args => {
        const expression = stringArg(args, 'expression');
        if (!/^[\d\s+\-*/().%]+$/.test(expression)) {
          return failed('Only simple numeric expressions are allowed.', { expression });
        }

        try {
          const result = Function(`"use strict"; return (${expression});`)() as unknown;
          return completedJson({ expression, result });
        } catch (error) {
          return failed('Calculation failed.', {
            expression,
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  ];
}
