import type { AgentInputResumeMode, AgentInputSchema } from '../domain/index.js';
import type { RuntimeTool } from './types.js';
import { failed, stringArg } from './types.js';

export function createHitlTools(): RuntimeTool[] {
  return [
    {
      name: 'request_user_input',
      description: 'Ask the user for required text, choice, multi-choice, or approval input and pause the agent until the user answers.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short title shown in the UI.',
          },
          prompt: {
            type: 'string',
            description: 'The question or instruction shown to the user.',
          },
          resumeMode: {
            type: 'string',
            enum: ['answer_as_tool_result', 'answer_as_user_input'],
            description: 'How the answer should be injected when the agent resumes. Defaults to answer_as_tool_result.',
          },
          input: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  type: { const: 'text' },
                  placeholder: { type: 'string' },
                  defaultValue: { type: 'string' },
                },
                required: ['type'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  type: { const: 'single_choice' },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        value: { type: 'string' },
                      },
                      required: ['label', 'value'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['type', 'options'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  type: { const: 'multi_choice' },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        value: { type: 'string' },
                      },
                      required: ['label', 'value'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['type', 'options'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  type: { const: 'approval' },
                  approveLabel: { type: 'string' },
                  rejectLabel: { type: 'string' },
                },
                required: ['type'],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ['prompt', 'input'],
        additionalProperties: false,
      },
      execute: async args => {
        const prompt = stringArg(args, 'prompt').trim();
        if (!prompt) {
          return failed('request_user_input requires a non-empty prompt.');
        }

        const input = parseInputSchema(args.input);
        if (!input) {
          return failed('request_user_input requires a valid input schema.', { input: args.input });
        }

        const resumeMode = parseResumeMode(args.resumeMode);
        if (!resumeMode) {
          return failed('Invalid resumeMode for request_user_input.', { resumeMode: args.resumeMode });
        }

        return {
          type: 'requires_user_input',
          request: {
            source: 'tool',
            resumeMode,
            title: stringArg(args, 'title').trim() || undefined,
            prompt,
            input,
          },
        };
      },
    },
  ];
}

function parseResumeMode(value: unknown): AgentInputResumeMode | null {
  if (value === undefined) {
    return 'answer_as_tool_result';
  }
  return value === 'answer_as_tool_result' || value === 'answer_as_user_input' ? value : null;
}

function parseInputSchema(value: unknown): AgentInputSchema | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const input = value as Record<string, unknown>;
  if (input.type === 'text') {
    return {
      type: 'text',
      placeholder: typeof input.placeholder === 'string' ? input.placeholder : undefined,
      defaultValue: typeof input.defaultValue === 'string' ? input.defaultValue : undefined,
    };
  }

  if (input.type === 'approval') {
    return {
      type: 'approval',
      approveLabel: typeof input.approveLabel === 'string' ? input.approveLabel : undefined,
      rejectLabel: typeof input.rejectLabel === 'string' ? input.rejectLabel : undefined,
    };
  }

  if (input.type === 'single_choice' || input.type === 'multi_choice') {
    const options = parseOptions(input.options);
    if (!options) {
      return null;
    }
    return {
      type: input.type,
      options,
    };
  }

  return null;
}

function parseOptions(value: unknown): Array<{ label: string; value: string }> | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const options = value
    .map(option => {
      if (!option || typeof option !== 'object') {
        return null;
      }
      const item = option as Record<string, unknown>;
      if (typeof item.label !== 'string' || typeof item.value !== 'string') {
        return null;
      }
      return { label: item.label, value: item.value };
    });

  return options.every((option): option is { label: string; value: string } => option !== null)
    ? options
    : null;
}
