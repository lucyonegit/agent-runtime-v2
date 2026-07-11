import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RuntimeTool, RuntimeUserInputArtifact } from '../../runtime/tool-executor.js';

export function createDefaultTools(): RuntimeTool[] {
  const requestUserInput = new DynamicStructuredTool({
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
    } as const,
    responseFormat: 'content_and_artifact',
    func: async arguments_ => {
      const input = arguments_ as Record<string, unknown>;
      const artifact: RuntimeUserInputArtifact = {
        type: 'requires_user_input',
        request: {
          source: 'tool',
          answerMode: 'as_tool_result',
          prompt: typeof input.prompt === 'string' ? input.prompt : 'Additional input is required.',
          ...(typeof input.title === 'string' ? { title: input.title } : {}),
          inputSchema: { type: 'text' },
          ...(input.sensitive === true ? { sensitiveAnswer: true } : {}),
        },
      };
      return ['User input is required before execution can continue.', artifact];
    },
  });
  return [{ tool: requestUserInput, sideEffectLevel: 'read_only' }];
}
