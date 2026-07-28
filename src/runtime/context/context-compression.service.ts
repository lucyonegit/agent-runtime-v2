import { createHash, randomUUID } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';
import {
  DEFAULT_CONTEXT_CONFIG,
  type ContextConfig,
} from '../../config/runtime-config.js';
import type { AgentJob } from '../../domain/index.js';
import type { AgentStore } from '../../storage/agent-store.js';
import { compileContext } from './context-compiler.js';
import {
  buildCompressionMaterial,
  estimateContextGroupTokens,
  orderedContextGroups,
  parseGeneratedContextMemory,
  parsePreviousContextMemory,
  protectedTailGroupIds,
  selectCompressionBatch,
  serializeContextGroup,
  uniqueStrings,
} from './helpers/context-memory.helper.js';
import { messagesInGroup } from './helpers/message-group.helper.js';
import { estimateTextTokens } from './helpers/token-budget.helper.js';
import {
  CONTEXT_MEMORY_SYSTEM_PROMPT_VERSION,
} from '../prompting/context-memory-prompt.js';
import type {
  BuiltContext,
  ContextMaterial,
} from './types/context.types.js';
import type { ContextMemoryV1 } from './types/context-memory.types.js';

type ContextCompressionStore = Pick<AgentStore['context'], 'replaceSummary'>;

export interface ContextCompressionServiceOptions {
  store: ContextCompressionStore;
  modelName: string;
  clock?: { nowMs(): number };
  ids?: { summaryId(): string };
  recentRawTokenBudget?: number;
  minimumRecentGroups?: number;
  contextConfig?: ContextConfig;
}

/**
 * 将稳定的 MessageGroup 压缩成 Session 级滚动 ContextMemory。
 *
 * Job 不是压缩边界：同一个长 Job 早期产生的消息，只要已经离开“近期原文保护区”，
 * 也可以被滚动摘要覆盖。这样每轮 ReAct 都遵循同一套上下文治理规则。
 *
 * 返回 true 表示新的摘要已经持久化，调用方必须重新加载 ContextMaterial；
 * 返回 false 表示当前没有安全且有价值的可压缩批次。
 */
export class ContextCompressionService {
  readonly #clock: { nowMs(): number };
  readonly #ids: { summaryId(): string };

  constructor(private readonly options: ContextCompressionServiceOptions) {
    this.#clock = options.clock ?? { nowMs: () => Date.now() };
    this.#ids = options.ids ?? { summaryId: () => `summary_${randomUUID()}` };
  }

  async compress(input: {
    job: AgentJob;
    material: ContextMaterial;
    built?: BuiltContext;
    invoke(messages: BaseMessage[], built: BuiltContext, logicalCallKey: string): Promise<string>;
  }): Promise<boolean> {
    const contextConfig = this.options.contextConfig ?? DEFAULT_CONTEXT_CONFIG;

    // 先按会话真实时序展开所有 MessageGroup，后续的覆盖判断、保护尾部和批次选择
    // 都以 Group 为最小单位，避免拆散 assistant tool_call 与 tool_result。
    const ordered = orderedContextGroups(input.material);
    if (ordered.length === 0) return false;

    // rolling summary 是当前唯一有效的会话记忆；coveredGroupIds 用于排除已经摘要过的原文，
    // 防止同一批消息被重复输入压缩模型。
    const activeSummary = input.material.summaries.find(summary => (
      summary.summaryType === 'rolling'
    ));
    const coveredGroupIds = new Set(
      input.material.summaries.flatMap(summary => summary.sourceGroupIds ?? [])
    );
    const protectedMessageIds = new Set(input.material.compression.protectedMessageIds ?? []);
    const uncovered = ordered.filter(item => !coveredGroupIds.has(item.group.id));

    // 最近若干组消息必须保留原文，当前用户目标等协议关键消息也不能被摘要替代。
    // eligible 最终只包含：尚未覆盖、离开近期尾部、且不含受保护消息的稳定 Group。
    const protectedTail = protectedTailGroupIds(
      uncovered,
      input.material.compression.recentRawTokenBudget
        ?? this.options.recentRawTokenBudget
        ?? contextConfig.compression.recentRawTokenBudget,
      input.material.compression.minimumRecentGroups
        ?? this.options.minimumRecentGroups
        ?? contextConfig.compression.minimumRecentGroups
    );
    const eligible = uncovered.filter(item => (
      !protectedTail.has(item.group.id)
      && !messagesInGroup(item.group).some(message => protectedMessageIds.has(message.id))
    ));
    if (eligible.length === 0) return false;

    // 新一轮压缩不是重新总结整段历史，而是在上一版 ContextMemory 上增量合并新批次。
    const previousMemory = parsePreviousContextMemory(activeSummary?.summary);
    if (activeSummary && !previousMemory) {
      throw new Error(
        `Active rolling summary ${JSON.stringify(activeSummary.id)} is not ContextMemoryV1.`
      );
    }

    // 批次大小同时受最小收益、最大输入和模型输入比例约束；一次只处理一个安全批次。
    const source = selectCompressionBatch(
      eligible,
      previousMemory,
      input.material,
      contextConfig
    );
    if (source.length === 0) return false;
    const payload = {
      previousMemory,
      newBlocks: source.map(item => serializeContextGroup(
        item.group,
        item.bundleId,
        contextConfig
      )),
    };
    const serializedPayload = JSON.stringify(payload);

    // 压缩调用使用独立的 System Prompt 和 TokenBudget，不复用正常对话的完整输入。
    const compressionMaterial = buildCompressionMaterial(input.material, serializedPayload);
    const compressionContext = compileContext(compressionMaterial);
    const lastRowId = Math.max(...source.flatMap(item => (
      messagesInGroup(item.group).map(message => message.rowId)
    )));

    // invoke 由上层注入 AuditedChatModel，因此压缩模型调用同样拥有 ModelCall 审计记录。
    // logicalCallKey 使用最后一条 rowId，保证同一压缩批次的重试具有稳定标识。
    const raw = await input.invoke(
      compressionContext.messages,
      compressionContext,
      `context.compress:${input.job.sessionId}:${lastRowId}`
    );
    const generated = parseGeneratedContextMemory(raw);

    // 模型只负责生成 memory 内容；覆盖范围由 Runtime 根据真实消息重新计算，
    // 不能相信模型自行声明哪些消息已被摘要。
    const previousCoverage = previousMemory?.coverage;
    const sourceMessages = source.flatMap(item => messagesInGroup(item.group));
    const groupIds = uniqueStrings([
      ...(previousCoverage?.groupIds ?? []),
      ...source.map(item => item.group.id),
    ]);
    const messageIds = uniqueStrings([
      ...(previousCoverage?.messageIds ?? []),
      ...sourceMessages.map(message => message.id),
    ]);
    const bundleIds = uniqueStrings([
      ...(previousCoverage?.bundleIds ?? []),
      ...source.map(item => item.bundleId),
    ]);
    const jobIds = uniqueStrings([
      ...(previousCoverage?.jobIds ?? []),
      ...sourceMessages.map(message => message.jobId),
    ]);
    const sourceRowIdStart = Math.min(
      activeSummary?.sourceRowIdStart ?? Number.MAX_SAFE_INTEGER,
      ...sourceMessages.map(message => message.rowId)
    );
    const sourceRowIdEnd = Math.max(
      activeSummary?.sourceRowIdEnd ?? 0,
      ...sourceMessages.map(message => message.rowId)
    );
    const summary: ContextMemoryV1 = {
      schemaVersion: 1,
      coverage: {
        groupIds,
        messageIds,
        bundleIds,
        jobIds,
        sourceRowIdStart,
        sourceRowIdEnd,
      },
      memory: generated,
    };
    const serialized = JSON.stringify(summary);
    const newSourceTokens = source.reduce(
      (total, item) => total + estimateContextGroupTokens(item.group),
      0
    );

    // 原子替换 Session 当前的 rolling summary，同时保留 parentSummaryId 和输入清单用于审计。
    // 成功落库后返回 true，构建循环会重新读取数据，此时已覆盖的原文将不再进入模型上下文。
    await this.options.store.replaceSummary({
      id: this.#ids.summaryId(),
      sessionId: input.job.sessionId,
      jobId: input.job.id,
      ownerType: 'session',
      ownerId: input.job.sessionId,
      purpose: 'conversation',
      contextRulesVersion: input.built?.contextRulesVersion
        ?? input.material.audit.contextRulesVersion,
      summaryType: 'rolling',
      sourceRowIdStart,
      sourceRowIdEnd,
      parentSummaryId: activeSummary?.id,
      summary: serialized,
      summaryFormat: 'json',
      sourceMessageCount: messageIds.length,
      sourceTokenCount: (activeSummary?.sourceTokenCount ?? 0) + newSourceTokens,
      summaryTokenCount: estimateTextTokens(serialized),
      model: this.options.modelName,
      compressionPromptVersion: CONTEXT_MEMORY_SYSTEM_PROMPT_VERSION,
      checksum: createHash('sha256').update(serialized).digest('hex'),
      metadata: {
        sourceGroupIds: groupIds,
        sourceBundleIds: bundleIds,
        sourceJobIds: jobIds,
        inputManifest: compressionContext.inputManifest,
      },
      nowMs: this.#clock.nowMs(),
    });
    return true;
  }
}
