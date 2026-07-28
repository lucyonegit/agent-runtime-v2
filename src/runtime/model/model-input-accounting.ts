import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  coerceMessageLikeToMessage,
  mapChatMessagesToStoredMessages,
  type BaseMessage,
  type StoredMessage,
} from '@langchain/core/messages';
import { estimateTextTokens } from '../context/helpers/token-budget.helper.js';
import { stableStringify } from '../helpers/stable-json.helper.js';

export interface ProjectedModelInput {
  storedMessages: StoredMessage[];
  serialized: string;
  estimatedTokens: number;
}

/** Canonical projection used for both preflight budgeting and persisted model-call audit. */
export function projectModelInput(input: BaseLanguageModelInput): ProjectedModelInput {
  let messages: BaseMessage[];
  if (typeof input === 'string') {
    messages = [coerceMessageLikeToMessage(['human', input])];
  } else if (Array.isArray(input)) {
    messages = input.map(coerceMessageLikeToMessage);
  } else {
    messages = input.toChatMessages();
  }
  const storedMessages = mapChatMessagesToStoredMessages(messages);
  const serialized = stableStringify(storedMessages);
  return {
    storedMessages,
    serialized,
    estimatedTokens: estimateTextTokens(serialized),
  };
}
