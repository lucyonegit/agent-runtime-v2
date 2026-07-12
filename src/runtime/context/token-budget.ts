export interface TokenBudgetItem<T> {
  id: string;
  value: T;
  estimatedTokens: number;
  mustKeep: boolean;
  priority: number;
  recency: number;
  originalOrder: number;
}

export interface TokenBudgetSelection<T> {
  selected: TokenBudgetItem<T>[];
  dropped: TokenBudgetItem<T>[];
  estimatedInputTokens: number;
  hardInputLimit: number;
  safeInputLimit: number;
  candidateTokens: number;
}

export class ContextOverflowError extends Error {
  readonly code = 'context_overflow';

  constructor(message: string) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

export class TokenBudget {
  select<T>(
    items: TokenBudgetItem<T>[],
    model: { maxContextTokens: number; reservedOutputTokens: number }
  ): TokenBudgetSelection<T> {
    const hardInputLimit = model.maxContextTokens - model.reservedOutputTokens;
    if (hardInputLimit <= 0) {
      throw new ContextOverflowError('Reserved output tokens consume the entire model context.');
    }
    const safeInputLimit = Math.floor(hardInputLimit * 0.9);
    const mustKeepItems = items.filter(item => item.mustKeep);
    const mustKeepTokens = sumTokens(mustKeepItems);
    if (mustKeepTokens > hardInputLimit) {
      throw new ContextOverflowError(
        `Must-keep context requires ${mustKeepTokens} tokens, above hard limit ${hardInputLimit}.`
      );
    }

    const selected = [...mustKeepItems];
    let selectedTokens = mustKeepTokens;
    const optional = items
      .filter(item => !item.mustKeep)
      .sort((left, right) => (
        right.priority - left.priority
        || right.recency - left.recency
        || left.originalOrder - right.originalOrder
      ));
    for (const item of optional) {
      if (selectedTokens + item.estimatedTokens > safeInputLimit) continue;
      selected.push(item);
      selectedTokens += item.estimatedTokens;
    }
    const selectedIds = new Set(selected.map(item => item.id));
    return {
      selected: selected.sort((left, right) => left.originalOrder - right.originalOrder),
      dropped: items.filter(item => !selectedIds.has(item.id)),
      estimatedInputTokens: selectedTokens,
      hardInputLimit,
      safeInputLimit,
      candidateTokens: sumTokens(items),
    };
  }
}

export function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function sumTokens(items: Array<{ estimatedTokens: number }>): number {
  return items.reduce((total, item) => total + item.estimatedTokens, 0);
}
