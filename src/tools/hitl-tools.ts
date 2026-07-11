import { DynamicStructuredTool } from '@langchain/core/tools';
import type {
  AgentUserInputSchema,
} from '../domain/index.js';
import type { RuntimeTool, RuntimeUserInputArtifact } from '../runtime/tool-executor.js';
import { stringArgument } from './tool-utils.js';

export function createHitlTools(): RuntimeTool[] {
  const requestUserInput = new DynamicStructuredTool({
    name: 'request_user_input',
    description: 'Pause execution and ask the user for text, choice, multi-choice, or approval input.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title shown in the UI.' },
        prompt: { type: 'string', description: 'Question or instruction shown to the user.' },
        sensitive: { type: 'boolean', description: 'Hide the answer from normal views.' },
        input: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { const: 'text' },
                placeholder: { type: 'string' },
                defaultValue: { type: 'string' },
                maxLength: { type: 'number' },
              },
              required: ['type'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { const: 'single_choice' },
                options: { type: 'array', items: optionSchema },
              },
              required: ['type', 'options'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { const: 'multi_choice' },
                min: { type: 'number' },
                max: { type: 'number' },
                options: { type: 'array', items: optionSchema },
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
      required: ['prompt'],
      additionalProperties: false,
    } as const,
    responseFormat: 'content_and_artifact',
    func: async input => {
      const values = input as Record<string, unknown>;
      const prompt = stringArgument(values, 'prompt').trim();
      if (!prompt) throw new Error('request_user_input requires a non-empty prompt.');
      const artifact: RuntimeUserInputArtifact = {
        type: 'requires_user_input',
        request: {
          source: 'tool',
          answerMode: 'as_tool_result',
          prompt,
          inputSchema: parseInputSchema(values.input),
          ...(stringArgument(values, 'title').trim()
            ? { title: stringArgument(values, 'title').trim() }
            : {}),
          ...(values.sensitive === true ? { sensitiveAnswer: true } : {}),
        },
      };
      return ['User input is required before execution can continue.', artifact];
    },
  });
  return [{ tool: requestUserInput, sideEffectLevel: 'read_only' }];
}

const optionSchema = {
  type: 'object',
  properties: { label: { type: 'string' }, value: { type: 'string' } },
  required: ['label', 'value'],
  additionalProperties: false,
} as const;

function parseInputSchema(value: unknown): AgentUserInputSchema {
  if (!value || typeof value !== 'object') return { type: 'text' };
  const input = value as Record<string, unknown>;
  if (input.type === 'text') {
    return {
      type: 'text',
      ...(typeof input.placeholder === 'string' ? { placeholder: input.placeholder } : {}),
      ...(typeof input.defaultValue === 'string' ? { defaultValue: input.defaultValue } : {}),
      ...(typeof input.maxLength === 'number' ? { maxLength: input.maxLength } : {}),
    };
  }
  if (input.type === 'approval') {
    return {
      type: 'approval',
      ...(typeof input.approveLabel === 'string' ? { approveLabel: input.approveLabel } : {}),
      ...(typeof input.rejectLabel === 'string' ? { rejectLabel: input.rejectLabel } : {}),
    };
  }
  if (input.type === 'single_choice' || input.type === 'multi_choice') {
    const options = parseOptions(input.options);
    if (options.length === 0) throw new Error(`${input.type} requires at least one option.`);
    return input.type === 'single_choice'
      ? { type: input.type, options }
      : {
          type: input.type,
          options,
          ...(typeof input.min === 'number' ? { min: input.min } : {}),
          ...(typeof input.max === 'number' ? { max: input.max } : {}),
        };
  }
  throw new Error('request_user_input received an invalid input schema.');
}

function parseOptions(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(option => {
    if (!option || typeof option !== 'object') return [];
    const item = option as Record<string, unknown>;
    return typeof item.label === 'string' && typeof item.value === 'string'
      ? [{ label: item.label, value: item.value }]
      : [];
  });
}
