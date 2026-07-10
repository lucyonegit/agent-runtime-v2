import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
  AgentContextBuildStrategy,
  AgentContextSnapshotKind,
  AgentContextSnapshotStatus,
  type AgentContextSnapshot,
  type AgentMessage,
  type AgentToolResult,
} from '../domain/index.js';
import type { AgentSessionStore } from '../storage/index.js';
import {
  DEFAULT_TOKEN_BUDGET,
  TokenBudgetManager,
  ApproximateTokenEstimator,
  type TokenBudgetConfig,
} from './token-budget.js';
import {
  BasicContextCompressor,
  sanitizeContextSnapshotSummary,
  type ContextCompressor,
} from './context-compressor.js';

export interface ContextBuilderOptions {
  includeThoughts?: boolean;
}

export interface BuildModelContextInput {
  store: AgentSessionStore;
  sessionId: string;
  taskId?: string;
  model?: string;
  systemPrompt?: string;
  budget?: TokenBudgetConfig;
  compressor?: ContextCompressor;
}

export interface BuiltModelContext {
  messages: BaseMessage[];
  snapshot?: AgentContextSnapshot;
  includedRowIdStart?: number;
  includedRowIdEnd?: number;
  estimatedTokens: number;
  strategy: AgentContextBuildStrategy;
  maxContextTokens: number;
  reservedOutputTokens: number;
  breakdown: {
    system?: number;
    snapshot?: number;
    recentMessages?: number;
    reservedOutput?: number;
  };
}

export class ContextBuilder {
  private readonly estimator = new ApproximateTokenEstimator();

  constructor(private readonly options: ContextBuilderOptions = {}) {}

  async buildForModel(input: BuildModelContextInput): Promise<BuiltModelContext> {
    const budget = input.budget ?? DEFAULT_TOKEN_BUDGET;
    const manager = new TokenBudgetManager(budget);
    const snapshot = await input.store.getActiveContextSnapshot(input.sessionId);
    const tail = snapshot
      ? await input.store.listMessagesAfterRowId(input.sessionId, snapshot.sourceRowIdEnd)
      : await input.store.listMessages(input.sessionId);

    const estimatedTokens = this.estimateContextTokens(input.systemPrompt, snapshot, tail);
    if (!manager.shouldCompress(estimatedTokens)) {
      return this.buildResult({
        input,
        snapshot: snapshot ?? undefined,
        tail,
        estimatedTokens,
        strategy: snapshot ? AgentContextBuildStrategy.SnapshotTail : AgentContextBuildStrategy.Full,
        budget,
      });
    }

    return this.compressAndRebuild(input, snapshot, tail, manager);
  }

  build(messages: AgentMessage[]): BaseMessage[] {
    const ordered = [...messages].sort((a, b) => a.rowId - b.rowId);
    const toolResultsByCallId = new Map<string, AgentMessage>();

    for (const message of ordered) {
      if (message.role === 'tool' && message.toolResult) {
        toolResultsByCallId.set(message.toolResult.toolCallId, message);
      }
    }

    const context: BaseMessage[] = [];

    for (const message of ordered) {
      if (message.role === 'tool') {
        continue;
      }

      if (message.toolCalls?.length) {
        const matchingResults = message.toolCalls.map(call => toolResultsByCallId.get(call.id));
        if (matchingResults.some(result => !result)) {
          continue;
        }

        context.push(new AIMessage({
          content: message.content,
          tool_calls: message.toolCalls.map(call => ({
            id: call.id,
            name: call.name,
            args: call.args,
            type: 'tool_call',
          })),
        }));

        for (const resultMessage of matchingResults) {
          if (!resultMessage?.toolResult) {
            continue;
          }
          context.push(this.toToolMessage(resultMessage.toolResult, resultMessage.content));
        }
        continue;
      }

      if (message.role === 'assistant' && message.channel === 'thought' && !this.options.includeThoughts) {
        continue;
      }

      if (message.role === 'system') {
        context.push(new SystemMessage(message.content));
      } else if (message.role === 'user') {
        context.push(new HumanMessage(message.content));
      } else if (message.role === 'assistant') {
        context.push(new AIMessage(message.content));
      }
    }

    return context;
  }

  private toToolMessage(toolResult: AgentToolResult, content: string): ToolMessage {
    return new ToolMessage({
      tool_call_id: toolResult.toolCallId,
      content,
    });
  }

  private async compressAndRebuild(
    input: BuildModelContextInput,
    snapshot: AgentContextSnapshot | null,
    tail: AgentMessage[],
    manager: TokenBudgetManager
  ): Promise<BuiltModelContext> {
    const budget = manager.getConfig();
    const keepTailCount = Math.min(budget.minTailMessages, tail.length);
    const compressibleTail = tail.slice(0, Math.max(0, tail.length - keepTailCount));

    if (!snapshot && compressibleTail.length === 0) {
      return this.buildResult({
        input,
        tail,
        estimatedTokens: this.estimateContextTokens(input.systemPrompt, snapshot, tail),
        strategy: AgentContextBuildStrategy.Full,
        budget,
      });
    }

    try {
      const compressor = input.compressor ?? new BasicContextCompressor();
      const compression = await compressor.compress({
        sessionId: input.sessionId,
        taskId: input.taskId,
        messages: compressibleTail,
        previousSummary: snapshot?.summary,
        maxSummaryTokens: budget.maxSnapshotTokens,
      });
      const lastCompressedRowId = compressibleTail.at(-1)?.rowId ?? snapshot?.sourceRowIdEnd;
      if (lastCompressedRowId === undefined) {
        return this.buildResult({
          input,
          snapshot: snapshot ?? undefined,
          tail,
          estimatedTokens: this.estimateContextTokens(input.systemPrompt, snapshot, tail),
          strategy: snapshot ? AgentContextBuildStrategy.SnapshotTail : AgentContextBuildStrategy.Full,
          budget,
        });
      }

      const newSnapshot = await input.store.replaceActiveContextSnapshot({
        id: this.createSnapshotId(),
        sessionId: input.sessionId,
        taskId: input.taskId,
        kind: AgentContextSnapshotKind.RollingSummary,
        sourceRowIdStart: snapshot?.sourceRowIdStart ?? compressibleTail[0]?.rowId ?? lastCompressedRowId,
        sourceRowIdEnd: lastCompressedRowId,
        baseSnapshotId: snapshot?.id,
        supersedesSnapshotId: snapshot?.id,
        summary: compression.summary,
        summaryFormat: 'markdown',
        sourceMessageCount: (snapshot?.sourceMessageCount ?? 0) + compressibleTail.length,
        sourceTokenCount: compression.sourceTokenCount,
        summaryTokenCount: compression.summaryTokenCount,
        model: input.model,
        compressionPromptVersion: compression.compressionPromptVersion,
        now: Date.now(),
      });
      const newTail = await input.store.listMessagesAfterRowId(input.sessionId, newSnapshot.sourceRowIdEnd);
      return this.buildResult({
        input,
        snapshot: newSnapshot,
        tail: newTail,
        estimatedTokens: this.estimateContextTokens(input.systemPrompt, newSnapshot, newTail),
        strategy: AgentContextBuildStrategy.CompressedThenSnapshotTail,
        budget,
      });
    } catch (error) {
      await input.store.createContextSnapshot({
        id: this.createSnapshotId(),
        sessionId: input.sessionId,
        taskId: input.taskId,
        kind: AgentContextSnapshotKind.RollingSummary,
        status: AgentContextSnapshotStatus.Failed,
        sourceRowIdStart: tail[0]?.rowId ?? snapshot?.sourceRowIdStart ?? 0,
        sourceRowIdEnd: tail.at(-1)?.rowId ?? snapshot?.sourceRowIdEnd ?? 0,
        summary: error instanceof Error ? error.message : 'Context compression failed',
        summaryFormat: 'markdown',
        sourceMessageCount: tail.length,
        compressionPromptVersion: 'failed',
        metadata: { error: error instanceof Error ? error.message : String(error) },
        now: Date.now(),
      });
      const fallbackTail = tail.slice(-budget.minTailMessages);
      return this.buildResult({
        input,
        tail: fallbackTail,
        estimatedTokens: this.estimateContextTokens(input.systemPrompt, undefined, fallbackTail),
        strategy: AgentContextBuildStrategy.TailOnlyFallback,
        budget,
      });
    }
  }

  private buildResult(input: {
    input: BuildModelContextInput;
    snapshot?: AgentContextSnapshot;
    tail: AgentMessage[];
    estimatedTokens: number;
    strategy: AgentContextBuildStrategy;
    budget: TokenBudgetConfig;
  }): BuiltModelContext {
    const breakdown = this.estimateBreakdown(input.input.systemPrompt, input.snapshot, input.tail, input.budget);
    return {
      messages: this.build(this.toSyntheticMessages(input.input, input.snapshot, input.tail)),
      snapshot: input.snapshot,
      includedRowIdStart: input.tail[0]?.rowId,
      includedRowIdEnd: input.tail.at(-1)?.rowId,
      estimatedTokens: input.estimatedTokens,
      strategy: input.strategy,
      maxContextTokens: input.budget.maxContextTokens,
      reservedOutputTokens: input.budget.reservedOutputTokens,
      breakdown,
    };
  }

  private toSyntheticMessages(
    input: BuildModelContextInput,
    snapshot: AgentContextSnapshot | undefined,
    tail: AgentMessage[]
  ): AgentMessage[] {
    const synthetic: AgentMessage[] = [];
    if (input.systemPrompt) {
      synthetic.push(this.systemMessage({
        id: 'synthetic_system_prompt',
        sessionId: input.sessionId,
        taskId: input.taskId,
        rowId: Number.MIN_SAFE_INTEGER,
        content: input.systemPrompt,
      }));
    }
    if (snapshot) {
      synthetic.push(this.systemMessage({
        id: `synthetic_snapshot_${snapshot.id}`,
        sessionId: input.sessionId,
        taskId: input.taskId,
        rowId: Number.MIN_SAFE_INTEGER + 1,
        content: sanitizeContextSnapshotSummary(snapshot.summary),
      }));
    }
    return [...synthetic, ...tail];
  }

  private systemMessage(input: {
    id: string;
    sessionId: string;
    taskId?: string;
    rowId: number;
    content: string;
  }): AgentMessage {
    return {
      id: input.id,
      sessionId: input.sessionId,
      taskId: input.taskId ?? 'context',
      rowId: input.rowId,
      role: 'system',
      messageKind: 'system_prompt',
      visibility: 'internal',
      content: input.content,
      createdAt: 0,
      metadata: { synthetic: true },
    };
  }

  private estimateContextTokens(
    systemPrompt: string | undefined,
    snapshot: AgentContextSnapshot | null | undefined,
    tail: AgentMessage[]
  ): number {
    const text = [
      systemPrompt,
      snapshot?.summary,
      ...tail.map(message => [
        message.role,
        message.content,
        message.toolCalls ? JSON.stringify(message.toolCalls) : undefined,
        message.toolResult ? JSON.stringify(message.toolResult) : undefined,
      ].filter(Boolean).join(' ')),
    ].filter(Boolean).join('\n');
    return this.estimator.countText(text);
  }

  private estimateBreakdown(
    systemPrompt: string | undefined,
    snapshot: AgentContextSnapshot | undefined,
    tail: AgentMessage[],
    budget: TokenBudgetConfig
  ): BuiltModelContext['breakdown'] {
    return {
      system: systemPrompt ? this.estimator.countText(systemPrompt) : undefined,
      snapshot: snapshot ? this.estimator.countText(snapshot.summary) : undefined,
      recentMessages: this.estimator.countText(tail.map(message => message.content).join('\n')),
      reservedOutput: budget.reservedOutputTokens,
    };
  }

  private createSnapshotId(): string {
    return `ctx_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}
