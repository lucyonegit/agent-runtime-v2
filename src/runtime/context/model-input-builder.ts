import { createHash } from 'node:crypto';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type {
  AgentContextInputManifest,
  AgentMessage,
  AgentTask,
  AgentTaskRun,
} from '../../domain/index.js';
import type { ContextConfig } from '../../config/runtime-config.js';
import type { AgentStore } from '../../storage/agent-store.js';
import type { AgentContextSnapshot } from '../../storage/agent-store.js';
import { RuntimeError } from '../errors/runtime-error.js';
import type { AuditedModelFactory } from '../model/audited-model.factory.js';
import { stableStringify } from '../helpers/stable-json.helper.js';
import { createTaskPromptManifest } from '../prompting/task-agent-prompt.js';
import { estimateTextTokens } from './helpers/token-budget.helper.js';
import { projectMessageGroups } from './helpers/message-group.helper.js';
import { MessageCompactor } from './message-compactor.js';
import {
  MODEL_INPUT_CONTEXT_RULES_VERSION,
  type ModelInput,
  type ModelMessageGroup,
} from './types/model-input.types.js';
import { projectModelInput } from '../model/model-input-accounting.js';

export interface ModelInputBuilderOptions {
  store: AgentStore;
  systemPrompt: string;
  systemPromptVersion: string;
  promptId: string;
  promptVersion: number;
  inputTokenLimit: number;
  reservedOutputTokens: number;
  contextConfig: ContextConfig;
  toolSchemas: StructuredToolInterface[];
  getStableContext(sessionId: string): string | Promise<string>;
  modelFactory?: AuditedModelFactory;
}

export interface PreparedTaskRunContext {
  loadMessages(): Promise<BaseMessage[]>;
  manifest(): AgentContextInputManifest;
}

/** The single production entry point for building LangChain model input. */
export class ModelInputBuilder {
  readonly #compactor?: MessageCompactor;

  constructor(private readonly options: ModelInputBuilderOptions) {
    if (options.modelFactory) {
      this.#compactor = new MessageCompactor({
        store: options.store,
        modelFactory: options.modelFactory,
        config: options.contextConfig,
        systemPromptVersion: options.systemPromptVersion,
        inputTokenLimit: options.inputTokenLimit,
      });
    }
  }

  /** Keeps per-run model input and its audit manifest behind one Context API. */
  prepareTaskRunContext(
    task: AgentTask,
    taskRun: AgentTaskRun,
    options: { signal?: AbortSignal } = {}
  ): PreparedTaskRunContext {
    let current: ModelInput | undefined;
    return {
      loadMessages: async () => {
        current = await this.buildForTask(task, taskRun, options);
        return current.messages;
      },
      manifest: () => {
        if (!current) {
          throw new Error('Model input is unavailable before Context has loaded its messages.');
        }
        return current.inputManifest;
      },
    };
  }

  async buildForTask(
    task: AgentTask,
    taskRun: AgentTaskRun,
    options: { signal?: AbortSignal } = {}
  ): Promise<ModelInput> {
    let built = await this.#build(task);
    let compactionPasses = 0;
    while (built.input.estimatedTokens > built.input.inputTokenLimit) {
      if (!this.#compactor) {
        throw new RuntimeError('model_input_too_large', 'Model input exceeds the configured input token limit.');
      }
      if (compactionPasses >= MAX_COMPACTION_PASSES_PER_BUILD) {
        throw new RuntimeError('model_input_too_large', 'Model input requires too many compaction passes.', {
          details: {
            estimatedTokens: built.input.estimatedTokens,
            inputTokenLimit: built.input.inputTokenLimit,
            compactedThroughRowId: built.input.compactedThroughRowId,
            compactionPasses,
          },
        });
      }
      const eligible = filterContextMessages(built.snapshot.messages, task);
      const projection = projectMessageGroups(eligible);
      const previousCutoff = built.snapshot.compaction?.throughMessageRowId ?? 0;
      const updated = await this.#compactor.compact({
        task,
        taskRun,
        groups: projection.groups,
        current: built.snapshot.compaction,
        signal: options.signal,
      });
      if (!updated || updated.throughMessageRowId <= previousCutoff) {
        throw new RuntimeError(
          'model_input_too_large',
          'Model input is too large and has no older complete messages to compact.'
        );
      }
      compactionPasses += 1;
      built = await this.#build(task);
    }
    return built.input;
  }

  /** Read-only inspection uses the exact builder without mutating compaction state. */
  async previewTask(task: AgentTask): Promise<ModelInput> {
    return (await this.#build(task)).input;
  }

  async previewNextTurn(sessionId: string): Promise<ModelInput> {
    const tasks = await this.options.store.sessions.listTasks(sessionId);
    const task = [...tasks].sort((left, right) => right.createdAtMs - left.createdAtMs)[0];
    if (!task) throw new RuntimeError('invalid_task_state', `Session ${sessionId} has no Task to inspect.`);
    return (await this.#build(task)).input;
  }

  async #build(task: AgentTask): Promise<{
    input: ModelInput;
    snapshot: AgentContextSnapshot;
  }> {
    const [snapshot, stableContext] = await Promise.all([
      this.options.store.context.loadInputSnapshot({
        sessionId: task.sessionId,
        taskId: task.id,
        goalMessageId: task.goalMessageId,
      }),
      this.options.getStableContext(task.sessionId),
    ]);
    const eligible = filterContextMessages(snapshot.messages, task);
    const projection = projectMessageGroups(eligible);
    const rawGroups = projection.groups;
    const groups = selectGroupsAfterCompaction(
      rawGroups,
      task,
      snapshot.compaction?.throughMessageRowId ?? 0
    );
    const projectedToolResultMessageIds: string[] = [];
    const projectedGroups = groups.map(group => projectToolResults(
      group,
      this.options.contextConfig.maxToolResultTokens,
      projectedToolResultMessageIds
    ));
    const outcomeUnknownContext = formatOutcomeUnknownContext(
      snapshot.outcomeUnknownToolCalls ?? []
    );

    const messages: BaseMessage[] = [
      new SystemMessage(this.options.systemPrompt),
      new SystemMessage(stableContext),
      ...(snapshot.compaction
        ? [new SystemMessage(`Earlier conversation summary:\n${snapshot.compaction.summary}`)]
        : []),
      ...(outcomeUnknownContext
        ? [new SystemMessage(outcomeUnknownContext)]
        : []),
      ...projectedGroups.flatMap(group => group.messages.map(toLangChainMessage)),
      ...(snapshot.activePlan?.taskId === task.id ? [new SystemMessage(
        `Active plan (authoritative):\n${JSON.stringify({
          title: snapshot.activePlan.title,
          steps: snapshot.activePlan.steps,
        })}`
      )] : []),
    ];
    const estimatedTokens = projectModelInput(messages).estimatedTokens
      + estimateTextTokens(stableStringify(this.options.toolSchemas.map(toolSchemaProjection)));
    const includedMessages = projectedGroups.flatMap(group => group.messages);
    const inputManifest = this.#manifest({
      groups: projectedGroups,
      messages: includedMessages,
      compactionVersion: snapshot.compaction?.version,
      compactionSummary: snapshot.compaction?.summary,
      estimatedTokens,
      stableContext,
      outcomeUnknownContext,
      excludedToolCallMessageIds: projection.excludedToolCallMessageIds,
      projectedToolResultMessageIds,
    });
    return {
      snapshot,
      input: {
        messages,
        estimatedTokens,
        inputTokenLimit: this.options.inputTokenLimit,
        includedMessageIds: includedMessages.map(message => message.id),
        ...(snapshot.compaction
          ? { compactedThroughRowId: snapshot.compaction.throughMessageRowId }
          : {}),
        projectedToolResultMessageIds,
        inputManifest,
      },
    };
  }

  #manifest(input: {
    groups: ModelMessageGroup[];
    messages: AgentMessage[];
    compactionVersion?: number;
    compactionSummary?: string;
    estimatedTokens: number;
    stableContext: string;
    outcomeUnknownContext: string | undefined;
    excludedToolCallMessageIds: string[];
    projectedToolResultMessageIds: string[];
  }): AgentContextInputManifest {
    const systemTokens = estimateTextTokens(this.options.systemPrompt)
      + estimateTextTokens(input.stableContext)
      + estimateTextTokens(input.outcomeUnknownContext ?? '');
    const summaryTokens = estimateTextTokens(input.compactionSummary ?? '');
    const toolTokens = estimateTextTokens(stableStringify(this.options.toolSchemas.map(toolSchemaProjection)));
    const messageTokens = Math.max(
      0,
      input.estimatedTokens - systemTokens - summaryTokens - toolTokens
    );
    const prompt = createTaskPromptManifest({
      systemPrompt: this.options.systemPrompt,
      promptId: this.options.promptId,
      promptVersion: this.options.promptVersion,
      stableContext: input.stableContext,
    });
    return {
      purpose: 'task.react',
      contextRulesVersion: MODEL_INPUT_CONTEXT_RULES_VERSION,
      systemPromptVersion: this.options.systemPromptVersion,
      prompt,
      messageGroupIds: input.groups.map(group => group.id),
      summaryIds: input.compactionVersion === undefined
        ? []
        : [`context_compaction:${input.compactionVersion}`],
      ...(input.excludedToolCallMessageIds.length > 0 ? {
        excludedToolCallMessageIds: input.excludedToolCallMessageIds,
      } : {}),
      ...(input.projectedToolResultMessageIds.length > 0 ? {
        truncatedToolResultMessageIds: input.projectedToolResultMessageIds,
      } : {}),
      ...(input.messages.length > 0 ? {
        includedRowIdStart: Math.min(...input.messages.map(message => message.rowId)),
        includedRowIdEnd: Math.max(...input.messages.map(message => message.rowId)),
      } : {}),
      toolSchemaChecksum: sha256(stableStringify(this.options.toolSchemas.map(toolSchemaProjection))),
      fixedPrefixChecksum: sha256(`${this.options.systemPrompt}\n${input.stableContext}`),
      estimatedBreakdown: {
        system: systemTokens,
        tools: toolTokens,
        summaries: summaryTokens,
        messages: messageTokens,
        reservedOutput: this.options.reservedOutputTokens,
      },
    };
  }
}

function formatOutcomeUnknownContext(
  toolCalls: AgentContextSnapshot['outcomeUnknownToolCalls']
): string | undefined {
  if (toolCalls.length === 0) return undefined;
  return [
    'Authoritative facts about earlier side-effecting tool executions with unavailable results:',
    stableStringify(toolCalls.map(toolCall => ({
      taskId: toolCall.taskId,
      toolCallId: toolCall.id,
      toolName: toolCall.toolName,
      arguments: toolCall.arguments,
      status: 'outcome_unknown',
      executionStarted: true,
      originalToolResultUnavailable: true,
    }))),
    'Do not assume whether any listed operation succeeded or failed, and do not automatically repeat it.',
    'Resolve each listed fact with authoritative read-only state when possible.',
    "If the current request depends on an unresolved operation or may repeat it, and the user's latest message does not explicitly resolve it, you MUST call request_user_input before continuing.",
    'If the user cannot confirm the outcome, do not ask the same question again. Stop any work that depends on or may repeat the operation.',
    'Treat the user answer as evidence, not as a recovered ToolResult. Retrieve any required result data from current state with a read-only tool.',
  ].join('\n');
}

const MAX_COMPACTION_PASSES_PER_BUILD = 8;

function filterContextMessages(messages: AgentMessage[], task: AgentTask): AgentMessage[] {
  return messages.filter(message => (
    message.contextScope === 'conversation'
    || (message.contextScope === 'task' && message.taskId === task.id)
  ) && message.channel !== 'progress' && message.messageType !== 'progress');
}

function selectGroupsAfterCompaction(
  groups: ModelMessageGroup[],
  task: AgentTask,
  cutoff: number
): ModelMessageGroup[] {
  const selected = groups.filter(group => (
    group.contextScope === 'task'
    || group.maxRowId > cutoff
    || group.messages.some(message => message.id === task.goalMessageId)
  ));
  const goalGroup = groups.find(group => group.messages.some(message => message.id === task.goalMessageId));
  if (goalGroup && !selected.includes(goalGroup)) selected.unshift(goalGroup);
  return selected.sort((left, right) => left.minRowId - right.minRowId);
}

function projectToolResults(
  group: ModelMessageGroup,
  maxTokens: number,
  projectedIds: string[]
): ModelMessageGroup {
  const messages = group.messages.map(message => {
    if (message.role !== 'tool' || estimateTextTokens(message.content) <= maxTokens) return message;
    projectedIds.push(message.id);
    const maxCharacters = Math.max(256, maxTokens * 3);
    const headLength = Math.floor(maxCharacters * 0.7);
    const tailLength = maxCharacters - headLength;
    return {
      ...message,
      content: [
        message.content.slice(0, headLength),
        `\n\n[Tool result projected: ${message.content.length - maxCharacters} characters omitted]\n\n`,
        message.content.slice(-tailLength),
      ].join(''),
    };
  });
  return {
    ...group,
    messages,
    estimatedTokens: estimateTextTokens(messages.map(message => message.content).join('\n')),
  };
}

function toLangChainMessage(message: AgentMessage): BaseMessage {
  if (message.role === 'user') return new HumanMessage(message.content);
  if (message.role === 'system') return new SystemMessage(message.content);
  if (message.role === 'tool') {
    if (!message.modelToolCallId) throw new Error(`ToolMessage ${message.id} has no modelToolCallId.`);
    return new ToolMessage({
      content: message.content,
      tool_call_id: message.modelToolCallId,
      ...(message.toolName ? { name: message.toolName } : {}),
    });
  }
  return new AIMessage({ content: message.content, tool_calls: message.toolCalls ?? [] });
}

function toolSchemaProjection(tool: StructuredToolInterface) {
  return { name: tool.name, description: tool.description, schema: tool.schema };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
