import type { AgentMessage } from '../../../domain/index.js';
import { stableStringify } from '../../helpers/stable-json.helper.js';

/** Projects durable structured failure data into the ToolMessage seen by the model. */
export function projectToolResultMessageForModel(message: AgentMessage): AgentMessage {
  const result = message.toolResult;
  if (message.role !== 'tool' || result?.status !== 'failed') return message;
  return {
    ...message,
    content: stableStringify({
      status: 'failed',
      code: result.code ?? 'tool_failed',
      error: result.error ?? message.content,
      ...(result.details === undefined ? {} : { details: result.details }),
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    }),
  };
}
