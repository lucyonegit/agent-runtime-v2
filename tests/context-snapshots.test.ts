import { describe, expect, it } from 'vitest';
import { BasicContextCompressor, DEFAULT_TOKEN_BUDGET, TokenBudgetManager } from '../src/context/index.js';
import { AgentContextSnapshotKind, AgentContextSnapshotStatus } from '../src/domain/index.js';

describe('context snapshot domain', () => {
  it('defines rolling active snapshots', () => {
    expect(AgentContextSnapshotKind.RollingSummary).toBe('rolling_summary');
    expect(AgentContextSnapshotStatus.Active).toBe('active');
  });

  it('detects when context exceeds compression threshold', () => {
    const manager = new TokenBudgetManager({
      ...DEFAULT_TOKEN_BUDGET,
      maxContextTokens: 100,
      reservedOutputTokens: 20,
      compressionTriggerRatio: 0.5,
    });

    expect(manager.shouldCompress(30)).toBe(false);
    expect(manager.shouldCompress(41)).toBe(true);
  });

  it('creates a structured rolling summary', async () => {
    const compressor = new BasicContextCompressor();
    const result = await compressor.compress({
      sessionId: 'session_ctx',
      taskId: 'task_ctx',
      messages: [
        { role: 'user', content: '帮我查资料' },
        { role: 'assistant', content: '我会先搜索资料。' },
      ],
      previousSummary: 'Earlier summary',
      maxSummaryTokens: 3000,
    });

    expect(result.summary).toContain('# Compressed Context Snapshot');
    expect(result.summary).toContain('Earlier summary');
    expect(result.summaryTokenCount).toBeGreaterThan(0);
  });

  it('excludes internal prompts and raw tool payloads from compressed summaries', async () => {
    const compressor = new BasicContextCompressor();
    const result = await compressor.compress({
      sessionId: 'session_ctx',
      taskId: 'task_ctx',
      messages: [
        {
          role: 'system',
          content: '# Role\n你是一个真实运行的 ReAct 执行型 Agent。',
          messageKind: 'system_prompt',
          visibility: 'internal',
          metadata: { kind: 'system_prompt', visibility: 'internal' },
        },
        {
          role: 'system',
          content: '查询2024年6月以来的资料',
          messageKind: 'planner_step_input',
          visibility: 'internal',
          metadata: { kind: 'planner_step_input', visibility: 'internal', stepId: 'step_1' },
        },
        {
          role: 'user',
          content: '美国与伊朗的国际局势咋样了？ 写一篇简单的报告给我',
          messageKind: 'message',
          visibility: 'ui',
        },
        {
          role: 'assistant',
          content: '我将检索权威报道。',
          messageKind: 'tool_call',
          visibility: 'ui',
          toolCalls: [
            {
              id: 'call_1',
              name: 'web_search',
              args: { query: 'US Iran nuclear deal 2024 Reuters' },
            },
          ],
          metadata: { stepId: 'step_1' },
        },
        {
          role: 'tool',
          content: JSON.stringify({
            query: 'US Iran nuclear deal 2024 Reuters',
            results: [
              {
                title: 'UN urges renewed diplomacy on Iran nuclear deal',
                url: 'https://news.un.org/example',
                snippet: 'Restoring the Iran nuclear deal remains elusive.',
              },
            ],
          }),
          messageKind: 'tool_result',
          visibility: 'ui',
          toolResult: {
            toolCallId: 'call_1',
            toolName: 'web_search',
            status: 'completed',
            result: {
              query: 'US Iran nuclear deal 2024 Reuters',
              results: [
                {
                  title: 'UN urges renewed diplomacy on Iran nuclear deal',
                  url: 'https://news.un.org/example',
                  snippet: 'Restoring the Iran nuclear deal remains elusive.',
                },
              ],
            },
          },
          metadata: { stepId: 'step_1' },
        },
        {
          role: 'assistant',
          channel: 'final',
          content: '美伊关系仍围绕核问题、制裁和地区安全保持紧张。',
          messageKind: 'step_result',
          visibility: 'ui',
          metadata: { kind: 'step_result', stepId: 'step_1' },
        },
      ],
      previousSummary: [
        '## Conversation Summary',
        'system: 你是一个 Planner，只输出 JSON。',
        'assistant: raw tool call tool_calls=[{"name":"web_search"}]',
      ].join('\n'),
      maxSummaryTokens: 3000,
    });

    expect(result.summary).toContain('## User Goal');
    expect(result.summary).toContain('美国与伊朗的国际局势');
    expect(result.summary).toContain('step_1: 美伊关系仍围绕核问题');
    expect(result.summary).toContain('web_search completed');
    expect(result.summary).not.toContain('你是一个真实运行的 ReAct');
    expect(result.summary).not.toContain('你是一个 Planner');
    expect(result.summary).not.toContain('planner_step_input');
    expect(result.summary).not.toContain('tool_calls=');
    expect(result.summary).not.toContain('tool_result=');
    expect(result.compressionPromptVersion).toBe('semantic-v1');
  });
});
