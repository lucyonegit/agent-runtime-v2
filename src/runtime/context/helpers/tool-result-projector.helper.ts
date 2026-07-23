import { createHash } from 'node:crypto';
import { estimateTextTokens } from './token-budget.helper.js';

interface ToolResultProjection {
  content: string;
  truncated: boolean;
  originalTokenEstimate: number;
  projectedTokenEstimate: number;
  checksum: string;
}

interface ToolResultContextProjectorOptions {
  maxTokens?: number;
  headRatio?: number;
}

export class ToolResultContextProjector {
  readonly #maxTokens: number;
  readonly #headRatio: number;

  constructor(options: ToolResultContextProjectorOptions = {}) {
    this.#maxTokens = options.maxTokens ?? 8_000;
    this.#headRatio = options.headRatio ?? 0.6;
  }

  project(value: unknown): ToolResultProjection {
    const content = typeof value === 'string' ? value : canonicalJson(value);
    const originalTokenEstimate = estimateTextTokens(content);
    const checksum = createHash('sha256').update(content).digest('hex');
    if (originalTokenEstimate <= this.#maxTokens) {
      return {
        content,
        truncated: false,
        originalTokenEstimate,
        projectedTokenEstimate: originalTokenEstimate,
        checksum,
      };
    }

    const marker = `\n\n[tool result truncated; originalTokens=${originalTokenEstimate}; checksum=sha256:${checksum}]\n\n`;
    // Character limits are unsafe for CJK. Find the largest head/tail slice
    // which satisfies the same estimator used by the global Context budget.
    let low = 0;
    let high = content.length;
    let projected = marker;
    while (low <= high) {
      const retainedCharacters = Math.floor((low + high) / 2);
      const headCharacters = Math.floor(retainedCharacters * this.#headRatio);
      const tailCharacters = retainedCharacters - headCharacters;
      const candidate = `${content.slice(0, headCharacters)}${marker}${
        tailCharacters > 0 ? content.slice(-tailCharacters) : ''
      }`;
      if (estimateTextTokens(candidate) <= this.#maxTokens) {
        projected = candidate;
        low = retainedCharacters + 1;
      } else {
        high = retainedCharacters - 1;
      }
    }
    return {
      content: projected,
      truncated: true,
      originalTokenEstimate,
      projectedTokenEstimate: estimateTextTokens(projected),
      checksum,
    };
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
