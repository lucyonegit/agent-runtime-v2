import { isAIMessage, isToolMessage, type BaseMessage } from '@langchain/core/messages';
import { buildContext } from '../../context/context-builder.js';
import type { AgentJob } from '../../domain/index.js';
import { RuntimeError } from '../../runtime/runtime-errors.js';
import { AgentStoreError, type AgentStore } from '../../storage/agent-store.js';
import type { RuntimeTool } from '../../runtime/tool-executor.js';
import {
  JOB_EXECUTION_SYSTEM_PROMPT,
  RUNTIME_SYSTEM_PROMPT_VERSION,
} from '../runtime/runtime-context-config.js';
import type { ContextPreviewMessage, ContextPreviewV1 } from './context-preview-contract.js';

const ACTIVE_JOB_STATUSES = new Set<AgentJob['status']>([
  'created',
  'running',
  'waiting_user_input',
  'resuming',
]);

export type ContextPreviewStore = Pick<AgentStore,
  | 'getSession'
  | 'listSessionJobs'
  | 'listSessionMessages'
  | 'listSessionToolInvocations'
>;

export interface ContextPreviewServiceOptions {
  store: ContextPreviewStore;
  tools: RuntimeTool[];
  provider: string;
  modelName: string;
  maxContextTokens: number;
  reservedOutputTokens: number;
  compressionMessageThreshold?: number;
  clock?: { nowMs(): number };
}

export class ContextPreviewService {
  readonly #options: ContextPreviewServiceOptions;

  constructor(options: ContextPreviewServiceOptions) {
    this.#options = options;
  }

  async preview(sessionId: string): Promise<ContextPreviewV1> {
    const session = await this.#options.store.getSession(sessionId);
    if (!session) {
      throw new AgentStoreError(
        'SESSION_NOT_FOUND',
        `Agent session ${JSON.stringify(sessionId)} was not found.`
      );
    }
    const [jobs, messages, invocations] = await Promise.all([
      this.#options.store.listSessionJobs(sessionId),
      this.#options.store.listSessionMessages(sessionId),
      this.#options.store.listSessionToolInvocations(sessionId),
    ]);
    assertNoActiveJob(jobs);
    const maxContextTokens = this.#options.maxContextTokens;
    const reservedOutputTokens = this.#options.reservedOutputTokens;
    const built = buildContext({
      purpose: 'job_execution',
      scope: { kind: 'session_history' },
      systemPrompt: JOB_EXECUTION_SYSTEM_PROMPT,
      systemPromptVersion: RUNTIME_SYSTEM_PROMPT_VERSION,
      messages,
      invocations,
      model: {
        provider: this.#options.provider,
        name: this.#options.modelName,
        maxContextTokens,
        reservedOutputTokens,
      },
      toolSchemas: this.#options.tools.map(item => item.tool),
      newCompressibleMessageCount: messages.length,
      compressionMessageThreshold: this.#options.compressionMessageThreshold ?? 50,
    });
    assertNoActiveJob(await this.#options.store.listSessionJobs(sessionId));
    return {
      schemaVersion: 1,
      debugOnly: true,
      generatedAtMs: this.#options.clock?.nowMs() ?? Date.now(),
      sessionId: session.id,
      ...latestJobId(jobs),
      contextRulesVersion: built.contextRulesVersion,
      systemPromptVersion: RUNTIME_SYSTEM_PROMPT_VERSION,
      estimatedInputTokens: built.estimatedInputTokens,
      compressionRecommended: built.compressionRecommended,
      limits: { maxContextTokens, reservedOutputTokens },
      manifest: built.inputManifest,
      messages: built.messages.map(toPreviewMessage),
    };
  }
}

function assertNoActiveJob(jobs: AgentJob[]): void {
  const active = [...jobs]
    .filter(job => ACTIVE_JOB_STATUSES.has(job.status))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  if (!active) return;
  throw new RuntimeError(
    'concurrency_conflict',
    `Context preview is unavailable while Job ${JSON.stringify(active.id)} is ${active.status}.`,
    { details: { jobId: active.id, status: active.status } }
  );
}

function latestJobId(jobs: AgentJob[]): { basedOnLatestJobId?: string } {
  const latest = [...jobs].sort((left, right) => (
    right.createdAtMs - left.createdAtMs || right.id.localeCompare(left.id)
  ))[0];
  return latest ? { basedOnLatestJobId: latest.id } : {};
}

function toPreviewMessage(message: BaseMessage, index: number): ContextPreviewMessage {
  const type = message.getType();
  if (isAIMessage(message)) {
    const toolCalls = message.tool_calls ?? [];
    return {
      index,
      type: 'ai',
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(toolCalls.length > 0 ? {
        toolCalls: toolCalls.map(call => ({
          id: call.id!,
          name: call.name,
          args: call.args,
        })),
      } : {}),
    };
  }
  if (isToolMessage(message)) {
    return {
      index,
      type: 'tool',
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      toolCallId: message.tool_call_id,
    };
  }
  if (type !== 'system' && type !== 'human') {
    throw new TypeError(`Unsupported Context preview message type: ${JSON.stringify(type)}.`);
  }
  const previewType: 'system' | 'human' = type === 'system' ? 'system' : 'human';
  return {
    index,
    type: previewType,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
  };
}
