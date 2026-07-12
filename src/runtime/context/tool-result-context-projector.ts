import { createHash } from 'node:crypto';
import { estimateTextTokens } from './token-budget.js';

export interface ToolResultProjection {
  content: string;
  truncated: boolean;
  originalTokenEstimate: number;
  projectedTokenEstimate: number;
  checksum: string;
}

export interface ToolResultContextProjectorOptions {
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
    const targetCharacters = Math.max(0, this.#maxTokens * 4 - marker.length);
    const headCharacters = Math.floor(targetCharacters * this.#headRatio);
    const tailCharacters = targetCharacters - headCharacters;
    const projected = `${content.slice(0, headCharacters)}${marker}${content.slice(-tailCharacters)}`;
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
