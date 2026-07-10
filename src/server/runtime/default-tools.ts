import type { RuntimeTool } from '../../runtime/tool-executor.js';

export function createDefaultTools(): RuntimeTool[] {
  return [{
    definition: {
      name: 'request_user_input',
      description: 'Pause execution and ask the user for required information or approval.',
      schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          title: { type: 'string' },
          sensitive: { type: 'boolean' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      sideEffectLevel: 'read_only',
    },
    execute: async arguments_ => ({
      type: 'requires_user_input',
      request: {
        source: 'tool',
        answerMode: 'as_tool_result',
        prompt: typeof arguments_.prompt === 'string' ? arguments_.prompt : 'Additional input is required.',
        ...(typeof arguments_.title === 'string' ? { title: arguments_.title } : {}),
        inputSchema: { type: 'text' },
        ...(arguments_.sensitive === true ? { sensitiveAnswer: true } : {}),
      },
    }),
  }];
}
