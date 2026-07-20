import { describe, expect, it } from 'vitest';
import { ToolResultContextProjector } from '../src/runtime/context/tool-result-context-projector.js';

describe('ToolResultContextProjector', () => {
  it('leaves short tool results unchanged', () => {
    const result = new ToolResultContextProjector({ maxTokens: 20 }).project('short result');
    expect(result).toMatchObject({
      content: 'short result',
      truncated: false,
      originalTokenEstimate: 4,
      projectedTokenEstimate: 4,
    });
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('deterministically retains the head and tail of oversized results', () => {
    const content = `${'A'.repeat(200)}${'B'.repeat(200)}`;
    const projector = new ToolResultContextProjector({ maxTokens: 50, headRatio: 0.6 });
    const first = projector.project(content);
    const second = projector.project(content);

    expect(first).toEqual(second);
    expect(first.truncated).toBe(true);
    expect(first.content).toContain('[tool result truncated;');
    expect(first.content.startsWith('A')).toBe(true);
    expect(first.content.endsWith('B')).toBe(true);
    expect(first.projectedTokenEstimate).toBeLessThan(first.originalTokenEstimate);
  });
});
