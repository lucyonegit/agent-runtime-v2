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

  selectWithContiguousTail<T>(
    items: TokenBudgetItem<T>[],
    model: { maxContextTokens: number; reservedOutputTokens: number },
    tailItemIds: ReadonlySet<string>
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
    const optionalNonTail = items
      .filter(item => !item.mustKeep && !tailItemIds.has(item.id))
      .sort((left, right) => (
        right.priority - left.priority
        || right.recency - left.recency
        || left.originalOrder - right.originalOrder
      ));
    for (const item of optionalNonTail) {
      if (selectedTokens + item.estimatedTokens > safeInputLimit) continue;
      selected.push(item);
      selectedTokens += item.estimatedTokens;
    }

    const optionalTail = items
      .filter(item => !item.mustKeep && tailItemIds.has(item.id))
      .sort((left, right) => right.originalOrder - left.originalOrder);
    for (const item of optionalTail) {
      if (selectedTokens + item.estimatedTokens > safeInputLimit) break;
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
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (isCjkCodePoint(codePoint)) cjk += 1;
    else if (codePoint <= 0x7f) ascii += 1;
    else other += 1;
  }
  // Qwen tokenizes CJK text much closer to one token per character than the
  // old GPT-oriented chars/4 heuristic. The 10% margin also covers message
  // framing and JSON/tool-call structure that are absent from plain text.
  return Math.max(1, Math.ceil((cjk + ascii / 4 + other / 2) * 1.1));
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x20000 && codePoint <= 0x323af)
    || (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
}

function sumTokens(items: Array<{ estimatedTokens: number }>): number {
  return items.reduce((total, item) => total + item.estimatedTokens, 0);
}
