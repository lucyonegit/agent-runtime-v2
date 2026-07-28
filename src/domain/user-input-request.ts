export type AgentUserInputStatus = 'pending' | 'answered' | 'cancelled' | 'expired';

export type AgentUserInputSchema =
  | { type: 'text'; placeholder?: string; defaultValue?: string; maxLength?: number }
  | { type: 'single_choice'; options: Array<{ label: string; value: string }> }
  | {
      type: 'multi_choice';
      min?: number;
      max?: number;
      options: Array<{ label: string; value: string }>;
    };

export type AgentUserInputAnswerValidation =
  | { valid: true }
  | { valid: false; reason: string };

export function validateAgentUserInputAnswer(
  schema: AgentUserInputSchema,
  answer: unknown
): AgentUserInputAnswerValidation {
  if (schema.type === 'text') {
    if (typeof answer !== 'string') return invalid('Text input requires a string answer.');
    if (schema.maxLength !== undefined) {
      if (!Number.isSafeInteger(schema.maxLength) || schema.maxLength < 0) {
        return invalid('Text input has an invalid maxLength constraint.');
      }
      if (answer.length > schema.maxLength) {
        return invalid(`Text input must not exceed ${schema.maxLength} characters.`);
      }
    }
    return { valid: true };
  }

  const allowedValues = new Set(schema.options.map(option => option.value));
  if (allowedValues.size !== schema.options.length || allowedValues.size === 0) {
    return invalid('Choice input has invalid or duplicate option values.');
  }
  if (schema.type === 'single_choice') {
    if (typeof answer !== 'string' || !allowedValues.has(answer)) {
      return invalid('Single-choice input requires one declared option value.');
    }
    return { valid: true };
  }

  if (!Array.isArray(answer) || !answer.every(value => typeof value === 'string')) {
    return invalid('Multi-choice input requires an array of option values.');
  }
  const selected = answer as string[];
  if (new Set(selected).size !== selected.length) {
    return invalid('Multi-choice input must not contain duplicate values.');
  }
  if (selected.some(value => !allowedValues.has(value))) {
    return invalid('Multi-choice input contains an undeclared option value.');
  }
  const minimum = schema.min ?? 0;
  const maximum = schema.max ?? schema.options.length;
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
    || minimum < 0 || maximum < minimum || maximum > schema.options.length) {
    return invalid('Multi-choice input has invalid selection bounds.');
  }
  if (selected.length < minimum || selected.length > maximum) {
    return invalid(`Multi-choice input requires between ${minimum} and ${maximum} selections.`);
  }
  return { valid: true };
}

function invalid(reason: string): AgentUserInputAnswerValidation {
  return { valid: false, reason };
}

/** request_user_input is the only producer; the answer is committed as ToolMessage. */
export interface AgentUserInputRequest {
  id: string;
  sessionId: string;
  taskId: string;
  toolCallId: string;
  status: AgentUserInputStatus;
  title?: string;
  prompt: string;
  inputSchema: AgentUserInputSchema;
  answerMessageId?: string;
  clientAnswerId?: string;
  expiresAtMs?: number;
  version: number;
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  answeredAtMs?: number;
}
