import { AGENT_REQUEST_LIMITS } from './request-limits.js';

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

export type AgentUserInputSchemaValidation = AgentUserInputAnswerValidation;

export function validateAgentUserInputSchema(
  schema: AgentUserInputSchema
): AgentUserInputSchemaValidation {
  if (schema.type === 'text') {
    if (schema.maxLength !== undefined
      && (!Number.isSafeInteger(schema.maxLength)
        || schema.maxLength < 0
        || schema.maxLength > AGENT_REQUEST_LIMITS.userInputTextCharacters)) {
      return invalid(
        `Text input maxLength must be between 0 and ${AGENT_REQUEST_LIMITS.userInputTextCharacters}.`
      );
    }
    if (schema.defaultValue !== undefined
      && schema.defaultValue.length > AGENT_REQUEST_LIMITS.userInputTextCharacters) {
      return invalid('Text input defaultValue exceeds the global input limit.');
    }
    if (schema.defaultValue !== undefined && schema.maxLength !== undefined
      && schema.defaultValue.length > schema.maxLength) {
      return invalid('Text input defaultValue exceeds maxLength.');
    }
    return { valid: true };
  }

  if (schema.options.length === 0) {
    return invalid('Choice input requires at least one option.');
  }
  if (schema.options.some(option => !option.label.trim() || !option.value)) {
    return invalid('Choice option labels and values must be non-empty.');
  }
  const allowedValues = new Set(schema.options.map(option => option.value));
  if (allowedValues.size !== schema.options.length) {
    return invalid('Choice option values must be unique.');
  }
  if (schema.type === 'single_choice') return { valid: true };

  const minimum = schema.min ?? 0;
  const maximum = schema.max ?? schema.options.length;
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
    || minimum < 0 || maximum < minimum || maximum > schema.options.length) {
    return invalid('Multi-choice selection bounds are invalid.');
  }
  return { valid: true };
}

export function validateAgentUserInputAnswer(
  schema: AgentUserInputSchema,
  answer: unknown
): AgentUserInputAnswerValidation {
  const schemaValidation = validateAgentUserInputSchema(schema);
  if (!schemaValidation.valid) return schemaValidation;
  if (schema.type === 'text') {
    if (typeof answer !== 'string') return invalid('Text input requires a string answer.');
    const maximum = schema.maxLength ?? AGENT_REQUEST_LIMITS.userInputTextCharacters;
    if (answer.length > maximum) {
      return invalid(`Text input must not exceed ${maximum} characters.`);
    }
    return { valid: true };
  }

  const allowedValues = new Set(schema.options.map(option => option.value));
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
  if (selected.length < minimum || selected.length > maximum) {
    return invalid(`Multi-choice input requires between ${minimum} and ${maximum} selections.`);
  }
  return { valid: true };
}

function invalid(reason: string): AgentUserInputAnswerValidation {
  return { valid: false, reason };
}

/** One explicit human decision point; the answer is committed as a ToolMessage. */
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
