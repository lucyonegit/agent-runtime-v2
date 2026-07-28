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
import { RuntimeError } from '../errors/runtime-error.js';
import type { AuditedModelFactory } from '../model/audited-model.factory.js';
import { stableStringify } from '../helpers/stable-json.helper.js';
import { createTaskPromptManifest } from '../prompting/task-agent-prompt.js';
import { estimateTextTokens } from './helpers/token-budget.helper.js';
import { buildCompleteMessageGroups } from './helpers/message-group.helper.js';
import { MessageCompactor } from './message-compactor.js';
import type { ModelInput, ModelMessageGroup } from './types/model-input.types.js';

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
      });
    }
  }

  async buildForTask(task: AgentTask, taskRun: AgentTaskRun): Promise<ModelInput> {
    let built = await this.#build(task);
    if (built.estimatedTokens <= built.inputTokenLimit) return built;
    if (!this.#compactor) {
      throw new RuntimeError('model_input_too_large', 'Model input exceeds the configured input token limit.');
    }

    const rawMessages = await this.options.store.sessions.listMessages(task.sessionId);
    const eligible = filterContextMessages(rawMessages, task);
    const compaction = await this.options.store.context.getCompaction(task.sessionId);
    const updated = await this.#compactor.compact({
      task,
      taskRun,
      groups: buildCompleteMessageGroups(eligible),
      current: compaction,
    });
    if (!updated) {
      throw new RuntimeError('model_input_too_large', 'Model input is too large and has no older complete messages to compact.');
    }

    built = await this.#build(task);
    if (built.estimatedTokens > built.inputTokenLimit) {
      throw new RuntimeError('model_input_too_large', 'Model input remains too large after one compaction pass.', {
        details: {
          estimatedTokens: built.estimatedTokens,
          inputTokenLimit: built.inputTokenLimit,
          compactedThroughRowId: built.compactedThroughRowId,
        },
      });
    }
    return built;
  }

  /** Read-only inspection uses the exact builder without mutating compaction state. */
  previewTask(task: AgentTask): Promise<ModelInput> {
    return this.#build(task);
  }

  async previewNextTurn(sessionId: string): Promise<ModelInput> {
    const tasks = await this.options.store.sessions.listTasks(sessionId);
    const task = [...tasks].sort((left, right) => right.createdAtMs - left.createdAtMs)[0];
    if (!task) throw new RuntimeError('invalid_task_state', `Session ${sessionId} has no Task to inspect.`);
    return this.#build(task);
  }

  async #build(task: AgentTask): Promise<ModelInput> {
    const [allMessages, compaction, activePlan, stableContext] = await Promise.all([
      this.options.store.sessions.listMessages(task.sessionId),
      this.options.store.context.getCompaction(task.sessionId),
      this.options.store.plans.getActive(task.sessionId),
      this.options.getStableContext(task.sessionId),
    ]);
    const eligible = filterContextMessages(allMessages, task);
    const rawGroups = buildCompleteMessageGroups(eligible);
    const groups = selectGroupsAfterCompaction(rawGroups, task, compaction?.throughMessageRowId ?? 0);
    const projectedToolResultMessageIds: string[] = [];
    const projectedGroups = groups.map(group => projectToolResults(
      group,
      this.options.contextConfig.maxToolResultTokens,
      projectedToolResultMessageIds
    ));

    const messages: BaseMessage[] = [
      new SystemMessage(this.options.systemPrompt),
      new SystemMessage(stableContext),
      ...(compaction ? [new SystemMessage(`Earlier conversation summary:\n${compaction.summary}`)] : []),
      ...projectedGroups.flatMap(group => group.messages.map(toLangChainMessage)),
      ...(activePlan?.taskId === task.id ? [new SystemMessage(
        `Active plan (authoritative):\n${JSON.stringify({ title: activePlan.title, steps: activePlan.steps })}`
      )] : []),
    ];
    const serialized = messages.map(message => `${message.getType()}:${message.text}`).join('\n');
    const estimatedTokens = estimateTextTokens(serialized)
      + estimateTextTokens(stableStringify(this.options.toolSchemas.map(toolSchemaProjection)));
    const includedMessages = projectedGroups.flatMap(group => group.messages);
    const inputManifest = this.#manifest({
      groups: projectedGroups,
      messages: includedMessages,
      compactionVersion: compaction?.version,
      compactionSummary: compaction?.summary,
      estimatedTokens,
      stableContext,
      projectedToolResultMessageIds,
    });
    return {
      messages,
      estimatedTokens,
      inputTokenLimit: this.options.inputTokenLimit,
      includedMessageIds: includedMessages.map(message => message.id),
      ...(compaction ? { compactedThroughRowId: compaction.throughMessageRowId } : {}),
      projectedToolResultMessageIds,
      inputManifest,
    };
  }

  #manifest(input: {
    groups: ModelMessageGroup[];
    messages: AgentMessage[];
    compactionVersion?: number;
    compactionSummary?: string;
    estimatedTokens: number;
    stableContext: string;
    projectedToolResultMessageIds: string[];
  }): AgentContextInputManifest {
    const systemTokens = estimateTextTokens(this.options.systemPrompt)
      + estimateTextTokens(input.stableContext);
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
      contextRulesVersion: 'model-input-v1',
      systemPromptVersion: this.options.systemPromptVersion,
      prompt,
      messageGroupIds: input.groups.map(group => group.id),
      summaryIds: input.compactionVersion === undefined
        ? []
        : [`context_compaction:${input.compactionVersion}`],
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
