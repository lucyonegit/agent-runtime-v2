import type { BuiltModelContext, ContextBuilder } from '../context/index.js';
import { resolve } from 'node:path';
import {
  AgentSessionPatchType,
  type AgentExecutorKind,
  transitionTaskStatus,
  type AgentInputRequest,
  type AgentSessionPatch,
  type AgentMessage,
  type AgentSessionMode,
  type AgentModelCallPurpose,
  type AgentTask,
  type AgentTaskKind,
} from '../domain/index.js';
import type { ReactCore, ReactCoreToolContext } from '../core/index.js';
import {
  CoreStepEventType,
  type CoreStepEvent,
  type CoreToolInputRequest,
} from '../core/index.js';
import type { AgentSessionStore } from '../storage/index.js';
import {
  defaultIdFactory,
  type AgentRunResult,
  type Clock,
  type IdFactory,
} from './types.js';
import { SessionEventEmitter } from './session-event-emitter.js';
import {
  REACT_SYSTEM_PROMPT,
  REACT_SYSTEM_PROMPT_VERSION,
} from './system-prompts.js';

export interface ReactAgentConfig {
  store: AgentSessionStore;
  contextBuilder: ContextBuilder;
  core: ReactCore;
  systemPrompt?: string;
  systemPromptVersion?: string;
  sessionMode?: AgentSessionMode;
  taskKind?: AgentTaskKind;
  executor?: AgentExecutorKind;
  taskProjectId?: string;
  taskMetadata?: Record<string, unknown>;
  toolContext?: Partial<ReactCoreToolContext>;
  modelName?: string;
  callPurpose?: AgentModelCallPurpose;
  sandboxRoot?: string;
  ids?: IdFactory;
  clock?: Clock;
  onEvent?: (event: AgentSessionPatch) => void | Promise<void>;
}

export class ReactAgent {
  private readonly createId: IdFactory;
  private readonly now: Clock;
  private readonly events: SessionEventEmitter;

  constructor(private readonly config: ReactAgentConfig) {
    this.createId = config.ids ?? defaultIdFactory;
    this.now = config.clock ?? (() => Date.now());
    this.events = new SessionEventEmitter(config);
  }

  async run(input: { sessionId: string; input: string }): Promise<AgentRunResult> {
    await this.ensureSession(input.sessionId, this.config.sessionMode ?? 'planner_react');
    const task = await this.config.store.createTask({
      id: this.createId('task'),
      sessionId: input.sessionId,
      kind: this.config.taskKind ?? 'react',
      executor: this.config.executor ?? 'react',
      projectId: this.config.taskProjectId,
      metadata: this.config.taskMetadata,
      now: this.now(),
    });

    await this.appendSystemPrompt(input.sessionId, task);

    const userMessage = await this.config.store.appendMessage({
      id: this.createId('msg'),
      sessionId: input.sessionId,
      taskId: task.id,
      role: 'user',
      content: input.input,
      createdAt: this.now(),
    });
    await this.emitUserMessageCreated(userMessage);

    const running = await this.config.store.updateTask(
      task.id,
      transitionTaskStatus(task, 'running', { now: this.now() })
    );
    await this.emitTaskStatusChanged(running);

    return this.continueTask(input.sessionId, running);
  }

  async answerInputRequest(input: {
    sessionId: string;
    requestId: string;
    value: unknown;
  }): Promise<AgentRunResult> {
    const requests = await this.config.store.listInputRequests(input.sessionId);
    const request = requests.find(item => item.id === input.requestId);
    if (!request) {
      throw new Error(`Input request not found: ${input.requestId}`);
    }
    if (request.status !== 'pending') {
      throw new Error(`Input request is not pending: ${input.requestId}`);
    }

    const [task] = (await this.config.store.listTasks(input.sessionId))
      .filter(item => item.id === request.taskId);
    if (!task) {
      throw new Error(`Task not found for input request: ${input.requestId}`);
    }

    const toolMessageId = this.createId('msg');
    const answeredAt = this.now();

    if (request.resumeMode === 'answer_as_tool_result') {
      const toolMessage = await this.appendToolAnswer(input.sessionId, request, input.value, toolMessageId, task.id);
      await this.emit({
        type: AgentSessionPatchType.ToolResultCompleted,
        sessionId: input.sessionId,
        message: toolMessage,
      });
    } else {
      const userMessage = await this.config.store.appendMessage({
        id: toolMessageId,
        sessionId: input.sessionId,
        taskId: task.id,
        role: 'user',
        content: this.stringifyAnswer(input.value),
        createdAt: this.now(),
        metadata: { inputRequestId: request.id, source: 'input_request_answer' },
      });
      await this.emitUserMessageCreated(userMessage);
    }

    await this.config.store.answerInputRequest(input.requestId, {
      value: input.value,
      messageId: toolMessageId,
      answeredAt,
    });

    const remainingPendingRequests = await this.listPendingInputRequests(input.sessionId, task.id);
    const latestTask = (await this.config.store.listTasks(input.sessionId)).find(item => item.id === task.id) ?? task;
    if (remainingPendingRequests.length > 0) {
      return this.markTaskWaitingForInput(input.sessionId, latestTask, remainingPendingRequests);
    }

    if (
      latestTask.status === 'running'
      || latestTask.status === 'resuming'
      || latestTask.status === 'completed'
      || latestTask.status === 'cancelled'
    ) {
      return { sessionId: input.sessionId, taskId: task.id, status: latestTask.status };
    }

    const resuming = await this.config.store.updateTask(
      task.id,
      transitionTaskStatus(latestTask, 'resuming', { now: this.now() })
    );
    await this.emitTaskStatusChanged(resuming);

    const running = await this.config.store.updateTask(
      task.id,
      transitionTaskStatus(resuming, 'running', { now: this.now() })
    );
    await this.emitTaskStatusChanged(running);
    return this.continueTask(input.sessionId, running);
  }

  private async continueTask(sessionId: string, task: AgentTask): Promise<AgentRunResult> {
    const context = await this.config.contextBuilder.buildForModel({
      store: this.config.store,
      sessionId,
      taskId: task.id,
    });
    let eventCount = 0;

    for await (const event of this.config.core.run({
      messages: context.messages,
      toolContext: {
        sessionId,
        taskId: task.id,
        sandboxRoot: this.getSandboxRoot(),
        ...this.config.toolContext,
      },
    })) {
      eventCount += 1;
      await this.applyCoreEventToSession(sessionId, task, event, context);
    }

    if (eventCount === 0) {
      return this.markTaskFailed(sessionId, task, new Error('Agent core completed without producing any events'));
    }

    const pendingRequests = await this.listPendingInputRequests(sessionId, task.id);
    if (pendingRequests.length > 0) {
      const latestTask = (await this.config.store.listTasks(sessionId)).find(item => item.id === task.id) ?? task;
      return this.markTaskWaitingForInput(sessionId, latestTask, pendingRequests);
    }

    const latestTask = (await this.config.store.listTasks(sessionId)).find(item => item.id === task.id) ?? task;
    if (latestTask.status !== 'completed') {
      const completed = await this.config.store.updateTask(
        task.id,
        transitionTaskStatus(latestTask, 'completed', { now: this.now() })
      );
      await this.emitTaskStatusChanged(completed);
      return { sessionId, taskId: task.id, status: 'completed' };
    }
    return { sessionId, taskId: task.id, status: latestTask.status };
  }

  private getSandboxRoot(): string {
    return resolve(this.config.sandboxRoot ?? '.agent-sandbox');
  }

  private async markTaskFailed(sessionId: string, task: AgentTask, error: Error): Promise<AgentRunResult> {
    const latestTask = (await this.config.store.listTasks(sessionId)).find(item => item.id === task.id) ?? task;
    const failed = await this.config.store.updateTask(
      task.id,
      transitionTaskStatus(latestTask, 'failed', {
        now: this.now(),
        error: {
          message: error.message,
          details: { name: error.name, stack: error.stack },
          failedAt: this.now(),
        },
      })
    );
    await this.emitTaskStatusChanged(failed);
    return { sessionId, taskId: task.id, status: 'failed' };
  }

  private async applyCoreEventToSession(
    sessionId: string,
    task: AgentTask,
    event: CoreStepEvent,
    context?: BuiltModelContext
  ): Promise<AgentRunResult | null> {
    if (event.type === CoreStepEventType.ModelOutputDelta) {
      await this.emit({
        type: AgentSessionPatchType.ModelOutputDelta,
        sessionId,
        taskId: task.id,
        messageId: this.events.getPendingAssistantMessageId(task.id, event.channel, event.outputId),
        channel: event.channel,
        outputId: event.outputId,
        delta: event.delta,
      });
      return null;
    }

    if (event.type === CoreStepEventType.ModelOutputCompleted) {
      const message = await this.config.store.appendMessage({
        id: this.events.consumePendingAssistantMessageId(task.id, event.channel, event.outputId),
        sessionId,
        taskId: task.id,
        role: 'assistant',
        channel: event.channel,
        content: event.content,
        toolCalls: event.toolCalls,
        createdAt: this.now(),
      });
      await this.emit({
        type: AgentSessionPatchType.ModelOutputCompleted,
        sessionId,
        outputId: event.outputId,
        message,
      });
      if (context) {
        await this.recordContextUsage(sessionId, task, context, event);
      }
      return null;
    }

    if (event.type === CoreStepEventType.ToolResultCompleted) {
      const message = await this.config.store.appendMessage({
        id: this.createId('msg'),
        sessionId,
        taskId: task.id,
        role: 'tool',
        content: event.content,
        toolResult: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'completed',
          result: event.result,
          durationMs: event.durationMs,
        },
        createdAt: this.now(),
      });
      await this.emit({
        type: AgentSessionPatchType.ToolResultCompleted,
        sessionId,
        message,
      });
      return null;
    }

    if (event.type === CoreStepEventType.ToolResultFailed) {
      const message = await this.config.store.appendMessage({
        id: this.createId('msg'),
        sessionId,
        taskId: task.id,
        role: 'tool',
        content: event.error,
        toolResult: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'failed',
          error: event.error,
          durationMs: event.durationMs,
        },
        createdAt: this.now(),
      });
      await this.emit({
        type: AgentSessionPatchType.ToolResultFailed,
        sessionId,
        message,
      });
      return null;
    }

    if (event.type === CoreStepEventType.ToolInputRequired) {
      const request = await this.createInputRequest(sessionId, task, {
        request: event.request,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      await this.emit({
        type: AgentSessionPatchType.ToolInputRequired,
        sessionId,
        request,
      });
      return null;
    }

    return null;
  }

  private async createInputRequest(
    sessionId: string,
    task: AgentTask,
    input: {
      request: CoreToolInputRequest;
      toolCallId?: string;
      toolName?: string;
    }
  ): Promise<AgentInputRequest> {
    const request = await this.config.store.createInputRequest({
      id: this.createId('input'),
      sessionId,
      taskId: task.id,
      source: input.request.source,
      resumeMode: input.request.resumeMode,
      prompt: input.request.prompt,
      input: input.request.input,
      title: input.request.title,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      now: this.now(),
    });
    return request;
  }

  private async markTaskWaitingForInput(
    sessionId: string,
    task: AgentTask,
    requests: AgentInputRequest[]
  ): Promise<AgentRunResult> {
    const waitingRequestIds = requests.map(request => request.id);
    const waiting = task.status === 'waiting_user_input'
      ? {
          ...task,
          status: 'waiting_user_input' as const,
          updatedAt: this.now(),
          waitingRequestId: waitingRequestIds[0],
          waitingRequestIds,
        }
      : transitionTaskStatus(task, 'waiting_user_input', {
          now: this.now(),
          waitingRequestId: waitingRequestIds[0],
          waitingRequestIds,
        });
    const updated = await this.config.store.updateTask(task.id, waiting);
    await this.emitTaskStatusChanged(updated);
    return {
      sessionId,
      taskId: task.id,
      status: 'waiting_user_input',
      waitingRequestId: waitingRequestIds[0],
      waitingRequestIds,
    };
  }

  private async appendToolAnswer(
    sessionId: string,
    request: AgentInputRequest,
    value: unknown,
    messageId: string,
    taskId: string
  ): Promise<AgentMessage> {
    if (!request.toolCallId || !request.toolName) {
      throw new Error(`Input request ${request.id} is missing tool call metadata`);
    }

    return this.config.store.appendMessage({
      id: messageId,
      sessionId,
      taskId,
      role: 'tool',
      content: this.stringifyAnswer(value),
      toolResult: {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        status: 'completed',
        result: value,
      },
      createdAt: this.now(),
      metadata: { inputRequestId: request.id },
    });
  }

  private async appendSystemPrompt(sessionId: string, task: AgentTask): Promise<AgentMessage> {
    return this.config.store.appendMessage({
      id: this.createId('msg'),
      sessionId,
      taskId: task.id,
      role: 'system',
      messageKind: 'system_prompt',
      visibility: 'internal',
      content: this.config.systemPrompt ?? REACT_SYSTEM_PROMPT,
      createdAt: this.now(),
      metadata: {
        kind: 'system_prompt',
        executor: this.config.executor ?? 'react',
        promptVersion: this.config.systemPromptVersion ?? REACT_SYSTEM_PROMPT_VERSION,
        scope: 'task',
      },
    });
  }

  private async ensureSession(sessionId: string, mode: AgentSessionMode): Promise<void> {
    const existing = await this.config.store.getSession(sessionId);
    if (!existing) {
      await this.config.store.createSession({
        id: sessionId,
        mode,
        now: this.now(),
      });
    }
  }

  private stringifyAnswer(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  private async listPendingInputRequests(sessionId: string, taskId: string): Promise<AgentInputRequest[]> {
    return (await this.config.store.listInputRequests(sessionId))
      .filter(request => request.taskId === taskId && request.status === 'pending');
  }

  private async emitTaskStatusChanged(task: AgentTask): Promise<void> {
    await this.emit({
      type: AgentSessionPatchType.TaskStatusChanged,
      sessionId: task.sessionId,
      task,
    });
  }

  private async recordContextUsage(
    sessionId: string,
    task: AgentTask,
    context: BuiltModelContext,
    event: Extract<CoreStepEvent, { type: CoreStepEventType.ModelOutputCompleted }>
  ): Promise<void> {
    const build = await this.config.store.createContextBuild({
      id: this.createRuntimeId('ctx_build'),
      sessionId,
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      taskKind: task.kind,
      executor: task.executor,
      snapshotId: context.snapshot?.id,
      model: this.config.modelName ?? 'unknown',
      callPurpose: this.config.callPurpose
        ?? (task.executor === 'code' ? 'code.react.loop' : 'react.loop'),
      strategy: context.strategy,
      maxContextTokens: context.maxContextTokens,
      reservedOutputTokens: context.reservedOutputTokens,
      estimatedInputTokens: context.estimatedTokens,
      includedRowIdStart: context.includedRowIdStart,
      includedRowIdEnd: context.includedRowIdEnd,
      breakdown: context.breakdown,
      now: this.now(),
    });
    await this.config.store.completeContextBuild(build.id, {
      usage: event.usage ?? { source: 'unavailable' },
      outputId: event.outputId,
      outputChannel: event.channel,
      resultType: event.toolCalls && event.toolCalls.length > 0
        ? 'tool_calls'
        : event.channel === 'final'
          ? 'assistant.final'
          : 'assistant.normal',
      toolCallCount: event.toolCalls?.length ?? 0,
      toolNames: event.toolCalls?.map(call => call.name) ?? [],
      completedAt: this.now(),
    });
    const stats = await this.config.store.getSessionTokenStats(sessionId);
    if (stats) {
      await this.emit({
        type: AgentSessionPatchType.ContextUsageUpdated,
        sessionId,
        stats,
      });
    }
  }

  private createRuntimeId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  private async emitUserMessageCreated(message: AgentMessage): Promise<void> {
    await this.emit({
      type: AgentSessionPatchType.UserMessageCreated,
      sessionId: message.sessionId,
      message,
    });
  }

  private async emit(value: AgentSessionPatch): Promise<void> {
    await this.events.emit(value);
  }
}
