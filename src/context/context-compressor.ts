import {
  inferAgentMessageKind,
  type AgentMessage,
  type AgentMessageKind,
} from '../domain/index.js';
import { ApproximateTokenEstimator } from './token-budget.js';

export interface CompressContextInput {
  sessionId: string;
  taskId?: string;
  messages: Array<Pick<AgentMessage,
    | 'role'
    | 'content'
    | 'channel'
    | 'toolCalls'
    | 'toolResult'
    | 'metadata'
    | 'messageKind'
    | 'visibility'
  >>;
  previousSummary?: string;
  maxSummaryTokens: number;
}

export interface CompressContextResult {
  summary: string;
  summaryTokenCount: number;
  sourceTokenCount: number;
  compressionPromptVersion: string;
}

export interface ContextCompressor {
  compress(input: CompressContextInput): Promise<CompressContextResult>;
}

export function sanitizeContextSnapshotSummary(summary: string | undefined): string {
  if (!summary) {
    return 'No previous stable summary.';
  }

  const lines = summary.split('\n');
  const cleaned: string[] = [];
  let skippingLegacyRawTranscript = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '## Recent Compressed Messages') {
      skippingLegacyRawTranscript = true;
      cleaned.push('## Previous Visible State');
      cleaned.push('Legacy raw transcript omitted because it contained internal prompts and tool payloads.');
      continue;
    }
    if (skippingLegacyRawTranscript && trimmed.startsWith('## ')) {
      skippingLegacyRawTranscript = false;
    }
    if (skippingLegacyRawTranscript) {
      continue;
    }
    if (
      trimmed.startsWith('system:')
      || trimmed.startsWith('tool:')
      || trimmed.includes('tool_calls=')
      || trimmed.includes('tool_result=')
      || trimmed.startsWith('# Role')
      || trimmed.startsWith('你是一个真实运行的 ReAct')
      || trimmed.startsWith('你是一个 Planner')
    ) {
      continue;
    }
    cleaned.push(line);
  }

  return cleaned.join('\n').trim() || 'Previous summary existed but only contained internal/raw messages.';
}

export class BasicContextCompressor implements ContextCompressor {
  private readonly estimator = new ApproximateTokenEstimator();

  async compress(input: CompressContextInput): Promise<CompressContextResult> {
    const summaryParts = this.collectSummaryParts(input.messages);
    const sourceText = summaryParts.sourceLines.join('\n');

    const summary = [
      '# Compressed Context Snapshot',
      '',
      '## Previous Stable Summary',
      this.sanitizePreviousSummary(input.previousSummary),
      '',
      '## User Goal',
      this.renderList(summaryParts.userGoals, 'No explicit user goal in compressed range.'),
      '',
      '## Plan State',
      this.renderList(summaryParts.planState, 'No active plan state in compressed range.'),
      '',
      '## Durable Results',
      this.renderList(summaryParts.durableResults, 'No durable step or final result in compressed range.'),
      '',
      '## Tool Evidence',
      this.renderList(summaryParts.toolEvidence, 'No tool evidence retained.'),
      '',
      '## Recent Visible Notes',
      this.renderList(summaryParts.visibleNotes, 'No additional visible notes retained.'),
      '',
      '## Open Questions',
      this.renderList(summaryParts.openQuestions, 'None recorded.'),
      '',
      '## Compression Rules Applied',
      '- Internal system prompts and planner step inputs were excluded.',
      '- Tool calls and tool results were summarized instead of preserving raw JSON.',
      '- Prefer plan, step_result, planner_final, and user-visible messages for future context.',
    ].join('\n').slice(0, this.maxSummaryChars(input.maxSummaryTokens));

    return {
      summary,
      summaryTokenCount: this.estimator.countText(summary),
      sourceTokenCount: this.estimator.countText(sourceText),
      compressionPromptVersion: 'semantic-v1',
    };
  }

  private collectSummaryParts(messages: CompressContextInput['messages']): {
    userGoals: string[];
    planState: string[];
    durableResults: string[];
    toolEvidence: string[];
    visibleNotes: string[];
    openQuestions: string[];
    sourceLines: string[];
  } {
    const userGoals: string[] = [];
    const planState: string[] = [];
    const durableResults: string[] = [];
    const toolEvidence: string[] = [];
    const visibleNotes: string[] = [];
    const openQuestions: string[] = [];
    const sourceLines: string[] = [];

    for (const message of messages) {
      const kind = this.getMessageKind(message);
      if (this.shouldExclude(message, kind)) {
        continue;
      }

      if (kind === 'plan' || kind === 'plan_update') {
        const line = this.formatPlanMessage(message, kind);
        planState.push(line);
        sourceLines.push(`${kind}: ${line}`);
        continue;
      }

      if (kind === 'step_result') {
        const stepId = this.getString(message.metadata?.stepId);
        const line = `${stepId ? `${stepId}: ` : ''}${this.compact(message.content)}`;
        durableResults.push(this.truncate(line, 800));
        sourceLines.push(`step_result: ${line}`);
        continue;
      }

      if (kind === 'planner_final' || (message.role === 'assistant' && message.channel === 'final')) {
        const line = this.truncate(this.compact(message.content), 1000);
        durableResults.push(`final: ${line}`);
        sourceLines.push(`planner_final: ${line}`);
        continue;
      }

      if (kind === 'tool_result') {
        const evidence = this.formatToolResult(message);
        toolEvidence.push(evidence);
        sourceLines.push(`tool_result: ${evidence}`);
        continue;
      }

      if (kind === 'tool_call') {
        const calls = message.toolCalls?.map(call => call.name).join(', ') || 'unknown_tool';
        const stepId = this.getString(message.metadata?.stepId);
        const line = `${stepId ? `${stepId}: ` : ''}called ${calls}`;
        toolEvidence.push(line);
        sourceLines.push(`tool_call: ${line}`);
        continue;
      }

      if (message.role === 'user') {
        const line = this.truncate(this.compact(message.content), 500);
        userGoals.push(line);
        sourceLines.push(`user: ${line}`);
        continue;
      }

      if (message.role === 'assistant') {
        const line = this.truncate(this.compact(message.content), 700);
        if (this.looksLikeQuestion(line)) {
          openQuestions.push(line);
        } else {
          visibleNotes.push(line);
        }
        sourceLines.push(`assistant: ${line}`);
      }
    }

    return {
      userGoals: this.uniqueLast(userGoals, 6),
      planState: this.uniqueLast(planState, 4),
      durableResults: this.uniqueLast(durableResults, 12),
      toolEvidence: this.uniqueLast(toolEvidence, 12),
      visibleNotes: this.uniqueLast(visibleNotes, 8),
      openQuestions: this.uniqueLast(openQuestions, 6),
      sourceLines,
    };
  }

  private shouldExclude(message: CompressContextInput['messages'][number], kind: AgentMessageKind): boolean {
    return message.visibility === 'internal'
      || message.metadata?.visibility === 'internal'
      || message.role === 'system'
      || kind === 'system_prompt'
      || kind === 'planner_step_input';
  }

  private getMessageKind(message: CompressContextInput['messages'][number]): AgentMessageKind {
    return message.messageKind ?? inferAgentMessageKind(message);
  }

  private formatPlanMessage(message: CompressContextInput['messages'][number], kind: AgentMessageKind): string {
    const plan = message.metadata?.plan;
    if (this.isObject(plan)) {
      const title = this.getString(plan.title) ?? this.getString(message.metadata?.title);
      const steps = Array.isArray(plan.steps)
        ? plan.steps
          .map(step => this.isObject(step) ? this.getString(step.title) : undefined)
          .filter((step): step is string => Boolean(step))
        : [];
      const stepText = steps.length ? ` steps=${steps.join(' | ')}` : '';
      return this.truncate(`${kind}${title ? `: ${title}` : ''}${stepText}`, 900);
    }
    return this.truncate(`${kind}: ${this.compact(message.content)}`, 900);
  }

  private formatToolResult(message: CompressContextInput['messages'][number]): string {
    const toolName = message.toolResult?.toolName ?? 'unknown_tool';
    const status = message.toolResult?.status ?? 'completed';
    const stepId = this.getString(message.metadata?.stepId);
    const summary = this.summarizeUnknown(message.toolResult?.result ?? this.tryParseJson(message.content) ?? message.content);
    return this.truncate(`${stepId ? `${stepId}: ` : ''}${toolName} ${status}: ${summary}`, 700);
  }

  private summarizeUnknown(value: unknown): string {
    if (typeof value === 'string') {
      return this.truncate(this.compact(value), 400);
    }

    if (Array.isArray(value)) {
      return `${value.length} items${value[0] ? `; first=${this.summarizeUnknown(value[0])}` : ''}`;
    }

    if (!this.isObject(value)) {
      return this.compact(String(value));
    }

    const result = this.isObject(value.result) ? value.result : value;
    const query = this.getString(result.query);
    const url = this.getString(result.url);
    const title = this.getString(result.title);
    const success = typeof result.success === 'boolean' ? `success=${result.success}` : undefined;
    const results = Array.isArray(result.results) ? result.results : undefined;
    const topResult = results?.find(item => this.isObject(item));
    const topTitle = this.isObject(topResult) ? this.getString(topResult.title) : undefined;
    const resultsText = results ? `results=${results.length}${topTitle ? ` top="${topTitle}"` : ''}` : undefined;

    const parts = [
      query ? `query="${query}"` : undefined,
      title ? `title="${title}"` : undefined,
      url ? `url=${url}` : undefined,
      resultsText,
      success,
    ].filter(Boolean);

    if (parts.length > 0) {
      return this.truncate(parts.join('; '), 400);
    }

    return this.truncate(this.compact(JSON.stringify(value)), 400);
  }

  private sanitizePreviousSummary(summary: string | undefined): string {
    return this.truncate(sanitizeContextSnapshotSummary(summary), 2000);
  }

  private renderList(items: string[], empty: string): string {
    if (items.length === 0) {
      return empty;
    }
    return items.map(item => `- ${item}`).join('\n');
  }

  private uniqueLast(items: string[], count: number): string[] {
    return [...new Set(items.filter(Boolean))].slice(-count);
  }

  private looksLikeQuestion(text: string): boolean {
    return /[?？]$/.test(text.trim()) || /请(告诉|选择|确认|输入|提供)/.test(text);
  }

  private compact(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
  }

  private maxSummaryChars(maxSummaryTokens: number): number {
    return Math.max(1000, maxSummaryTokens * 4);
  }

  private tryParseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private getString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
