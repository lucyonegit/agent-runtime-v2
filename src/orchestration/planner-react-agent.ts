import { resolve } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { ApproximateTokenEstimator, DEFAULT_TOKEN_BUDGET } from '../context/index.js';
import {
  CoreStepEventType,
  type CoreStepEvent,
  type PlannerCore,
  type PlannerPlan,
  type PlannerStep,
  type ReactCore,
} from '../core/index.js';
import type { ContextBuilder } from '../context/index.js';
import {
  AgentSessionPatchType,
  transitionTaskStatus,
  type AgentInputRequest,
  type AgentMessage,
  type AgentModelCallPurpose,
  type AgentModelCallResultType,
  type AgentModelTokenUsage,
  type AgentSessionPatch,
  type AgentTask,
} from '../domain/index.js';
import type { AgentSessionStore } from '../storage/index.js';
import type { SubmittedStepResult } from '../tools/planner-step-tools.js';
import {
  PLANNER_FINAL_SYSTEM_PROMPT,
  PLANNER_ROUTER_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  REACT_SYSTEM_PROMPT,
  REACT_SYSTEM_PROMPT_VERSION,
} from './system-prompts.js';
import {
  buildPlanCreateMessages,
  buildPlanFinalMessages,
  buildPlanStepMessages,
  buildPlannerRouteMessages,
  type PlannerRuntimeNow,
} from './planner-context-projection.js';
import { ReactAgent } from './react-agent.js';
import { SessionEventEmitter } from './session-event-emitter.js';
import {
  defaultIdFactory,
  type AgentRunResult,
  type Clock,
  type IdFactory,
} from './types.js';

export interface PlannerReactAgentConfig {
  store: AgentSessionStore;
  contextBuilder: ContextBuilder;
  planner: PlannerCore;
  directReact: ReactCore;
  stepReact: ReactCore;
  routerSystemPrompt?: string;
  plannerSystemPrompt?: string;
  reactSystemPrompt?: string;
  plannerFinalSystemPrompt?: string;
  timeZone?: string;
  sandboxRoot?: string;
  modelName?: string;
  ids?: IdFactory;
  clock?: Clock;
  onEvent?: (event: AgentSessionPatch) => void | Promise<void>;
}

export class PlannerReactAgent {
  private readonly createId: IdFactory;
  private readonly now: Clock;
  private readonly events: SessionEventEmitter;
  private readonly tokenEstimator = new ApproximateTokenEstimator();

  constructor(private readonly config: PlannerReactAgentConfig) {
    this.createId = config.ids ?? defaultIdFactory;
    this.now = config.clock ?? (() => Date.now());
    this.events = new SessionEventEmitter(config);
  }

  async run(input: { sessionId: string; goal: string }): Promise<AgentRunResult> {
    await this.ensureSession(input.sessionId);
    const routeMessages = buildPlannerRouteMessages({
      routerSystemPrompt: this.config.routerSystemPrompt ?? PLANNER_ROUTER_SYSTEM_PROMPT,
      goal: input.goal,
      now: this.getRuntimeNow(),
      visibleSummary: await this.buildVisibleSummary(input.sessionId),
    });
    const routeResult = await this.config.planner.routeGoal({ messages: routeMessages });
    if (routeResult.route.mode === 'direct_answer') {
      const result = await this.runDirectTask(input.sessionId, input.goal);
      const task = await this.requireTask(input.sessionId, result.taskId);
      await this.recordModelCall(task, routeMessages, 'planner.route', routeResult.usage, 'planner.route');
      return result;
    }
    return this.runPlannedTask(input.sessionId, input.goal, routeMessages, routeResult.usage);
  }

  async answerInputRequest(input: {
    sessionId: string;
    requestId: string;
    value: unknown;
  }): Promise<AgentRunResult> {
    const request = await this.requireInputRequest(input.sessionId, input.requestId);
    const task = await this.requireTask(input.sessionId, request.taskId);
    if (task.kind === 'react') {
      return this.createDirectAgent().answerInputRequest(input);
    }
    if (task.kind !== 'planner_step' || !task.parentTaskId) {
      throw new Error(`Unsupported task kind for PlannerReactAgent resume: ${task.kind}`);
    }

    await this.persistInputAnswer(request, task, input.value);
    const remaining = await this.listPendingRequests(input.sessionId, task.id);
    const root = await this.requireTask(input.sessionId, task.parentTaskId);
    if (remaining.length > 0) {
      await this.updateWaitingTask(task, remaining);
      await this.updateWaitingTask(root, remaining);
      return this.waitingResult(input.sessionId, root.id, remaining);
    }

    const runningRoot = await this.resumeTask(root);
    const runningStep = await this.resumeTask(task);
    return this.continuePlannedRun(runningRoot, runningStep);
  }

  private runDirectTask(sessionId: string, goal: string): Promise<AgentRunResult> {
    return this.createDirectAgent().run({ sessionId, input: goal });
  }

  private createDirectAgent(): ReactAgent {
    return new ReactAgent({
      store: this.config.store,
      contextBuilder: this.config.contextBuilder,
      core: this.config.directReact,
      systemPrompt: this.config.reactSystemPrompt ?? REACT_SYSTEM_PROMPT,
      systemPromptVersion: REACT_SYSTEM_PROMPT_VERSION,
      sessionMode: 'planner_react',
      taskKind: 'react',
      executor: 'react',
      sandboxRoot: this.config.sandboxRoot,
      modelName: this.config.modelName,
      callPurpose: 'planner.direct.react',
      ids: this.createId,
      clock: this.now,
      onEvent: this.config.onEvent,
    });
  }

  private async runPlannedTask(
    sessionId: string,
    goal: string,
    routeMessages: BaseMessage[],
    routeUsage?: AgentModelTokenUsage
  ): Promise<AgentRunResult> {
    const root = await this.config.store.createTask({
      id: this.createId('task'),
      sessionId,
      kind: 'planner',
      executor: 'planner',
      metadata: { goal },
      now: this.now(),
    });
    await this.appendInternalPrompt(root, this.config.plannerSystemPrompt ?? PLANNER_SYSTEM_PROMPT, {
      executor: 'planner',
      scope: 'plan',
    });
    const userMessage = await this.config.store.appendMessage({
      id: this.createId('msg'),
      sessionId,
      taskId: root.id,
      role: 'user',
      content: goal,
      createdAt: this.now(),
    });
    await this.emit({
      type: AgentSessionPatchType.UserMessageCreated,
      sessionId,
      message: userMessage,
    });
    const runningRoot = await this.transition(root, 'running');

    try {
      await this.recordModelCall(runningRoot, routeMessages, 'planner.route', routeUsage, 'planner.route');
      const planMessages = buildPlanCreateMessages({
        plannerSystemPrompt: this.config.plannerSystemPrompt ?? PLANNER_SYSTEM_PROMPT,
        goal,
        now: this.getRuntimeNow(),
        visibleSummary: await this.buildVisibleSummary(sessionId, userMessage.id),
      });
      const planResult = await this.config.planner.createPlan({ messages: planMessages });
      const { plan } = planResult;
      await this.recordModelCall(
        runningRoot,
        planMessages,
        'planner.plan.create',
        planResult.usage,
        'planner.plan'
      );
      await this.appendPlanMessage(runningRoot, plan);
      return this.runPlanFromIndex(runningRoot, plan, goal, 0);
    } catch (error) {
      return this.failTask(runningRoot, asError(error));
    }
  }

  private async runPlanFromIndex(
    root: AgentTask,
    plan: PlannerPlan,
    goal: string,
    startIndex: number,
    currentTask?: AgentTask
  ): Promise<AgentRunResult> {
    let task = currentTask;
    for (let index = startIndex; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      task = task ?? await this.createStepTask(root, plan, step, index);
      const stepResult = await this.runStep(root, task, plan, step, goal);
      if (stepResult.status === 'waiting_user_input') {
        return stepResult;
      }
      if (stepResult.status === 'failed') {
        const latestRoot = await this.requireTask(root.sessionId, root.id);
        return this.failTask(latestRoot, new Error(`Planner step failed: ${step.id}`));
      }
      task = undefined;
    }

    return this.finalizePlan(await this.requireTask(root.sessionId, root.id), plan, goal);
  }

  private async continuePlannedRun(root: AgentTask, stepTask: AgentTask): Promise<AgentRunResult> {
    const plan = await this.loadPlan(root.sessionId, root.id);
    const goal = this.readGoal(root);
    const stepId = this.readStepId(stepTask);
    const index = plan.steps.findIndex(step => step.id === stepId);
    if (index < 0) {
      return this.failTask(root, new Error(`Planner step not found in plan: ${stepId}`));
    }
    return this.runPlanFromIndex(root, plan, goal, index, stepTask);
  }

  private async createStepTask(
    root: AgentTask,
    plan: PlannerPlan,
    step: PlannerStep,
    stepIndex: number
  ): Promise<AgentTask> {
    const task = await this.config.store.createTask({
      id: this.createId('task'),
      sessionId: root.sessionId,
      parentTaskId: root.id,
      kind: 'planner_step',
      executor: 'react',
      metadata: {
        planId: plan.id,
        stepId: step.id,
        stepIndex,
        title: step.title,
        instruction: step.instruction,
      },
      now: this.now(),
    });
    await this.appendInternalPrompt(task, this.config.reactSystemPrompt ?? REACT_SYSTEM_PROMPT, {
      executor: 'react',
      scope: 'planner_step',
      stepId: step.id,
    });
    await this.config.store.appendMessage({
      id: this.createId('msg'),
      sessionId: root.sessionId,
      taskId: task.id,
      role: 'system',
      messageKind: 'planner_step_input',
      visibility: 'internal',
      content: step.instruction,
      createdAt: this.now(),
      metadata: {
        kind: 'planner_step_input',
        visibility: 'internal',
        planId: plan.id,
        stepId: step.id,
      },
    });
    return this.transition(task, 'running');
  }

  private async runStep(
    root: AgentTask,
    stepTask: AgentTask,
    plan: PlannerPlan,
    step: PlannerStep,
    goal: string
  ): Promise<AgentRunResult> {
    const messages = await this.buildStepContext(root, stepTask, plan, step, goal);
    let eventCount = 0;
    try {
      for await (const event of this.config.stepReact.run({
        messages,
        toolContext: {
          sessionId: root.sessionId,
          taskId: stepTask.id,
          sandboxRoot: resolve(this.config.sandboxRoot ?? '.agent-sandbox'),
        },
      })) {
        eventCount += 1;
        await this.applyStepEvent(root, stepTask, plan, step, event, messages);
      }
    } catch (error) {
      return this.failTask(stepTask, asError(error));
    }

    if (eventCount === 0) {
      return this.failTask(stepTask, new Error('Planner step core completed without producing any events'));
    }
    const pending = await this.listPendingRequests(root.sessionId, stepTask.id);
    if (pending.length > 0) {
      await this.updateWaitingTask(stepTask, pending);
      await this.updateWaitingTask(root, pending);
      return this.waitingResult(root.sessionId, root.id, pending);
    }
    const stableResult = await this.loadStepResult(root.sessionId, stepTask.id, step.id);
    if (!stableResult) {
      return this.failTask(stepTask, new Error(`Planner step completed without step_result: ${step.id}`));
    }
    const latestStep = await this.requireTask(root.sessionId, stepTask.id);
    if (latestStep.status !== 'completed') {
      await this.transition(latestStep, 'completed');
    }
    return { sessionId: root.sessionId, taskId: root.id, status: 'running' };
  }

  private async buildStepContext(
    root: AgentTask,
    stepTask: AgentTask,
    plan: PlannerPlan,
    step: PlannerStep,
    goal: string
  ): Promise<BaseMessage[]> {
    const messages = await this.config.store.listMessages(root.sessionId);
    const previousStepResults = messages.filter(message =>
      message.messageKind === 'step_result' && message.taskId !== stepTask.id
    );
    const currentRuntimeTail = messages.filter(message =>
      message.taskId === stepTask.id && message.visibility !== 'internal'
    );
    return buildPlanStepMessages({
      reactSystemPrompt: this.config.reactSystemPrompt ?? REACT_SYSTEM_PROMPT,
      goal,
      now: this.getRuntimeNow(),
      plan,
      currentStep: step,
      previousStepResults,
      currentRuntimeTail,
      contextBuilder: this.config.contextBuilder,
    });
  }

  private async applyStepEvent(
    root: AgentTask,
    task: AgentTask,
    plan: PlannerPlan,
    step: PlannerStep,
    event: CoreStepEvent,
    contextMessages: BaseMessage[]
  ): Promise<void> {
    if (event.type === CoreStepEventType.ModelOutputDelta) {
      await this.emit({
        type: AgentSessionPatchType.ModelOutputDelta,
        sessionId: root.sessionId,
        taskId: task.id,
        messageId: this.events.getPendingAssistantMessageId(task.id, event.channel, event.outputId),
        channel: event.channel,
        outputId: event.outputId,
        delta: event.delta,
      });
      return;
    }
    if (event.type === CoreStepEventType.ModelOutputCompleted) {
      const message = await this.config.store.appendMessage({
        id: this.events.consumePendingAssistantMessageId(task.id, event.channel, event.outputId),
        sessionId: root.sessionId,
        taskId: task.id,
        role: 'assistant',
        channel: event.channel,
        content: event.content,
        toolCalls: event.toolCalls,
        createdAt: this.now(),
        metadata: { planId: plan.id, stepId: step.id },
      });
      await this.emit({
        type: AgentSessionPatchType.ModelOutputCompleted,
        sessionId: root.sessionId,
        outputId: event.outputId,
        message,
      });
      await this.recordModelCall(
        task,
        contextMessages,
        'planner.step.react',
        event.usage,
        event.toolCalls?.length ? 'tool_calls' : event.channel === 'final' ? 'assistant.final' : 'assistant.normal',
        event.outputId,
        event.channel,
        event.toolCalls?.map(call => call.name)
      );
      return;
    }
    if (event.type === CoreStepEventType.ToolResultCompleted) {
      const message = await this.config.store.appendMessage({
        id: this.createId('msg'),
        sessionId: root.sessionId,
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
        metadata: { planId: plan.id, stepId: step.id },
      });
      await this.emit({
        type: AgentSessionPatchType.ToolResultCompleted,
        sessionId: root.sessionId,
        message,
      });
      const submitted = parseSubmittedStepResult(event.result);
      if (submitted) {
        if (submitted.stepId && submitted.stepId !== step.id) {
          throw new Error(`Step result ${submitted.stepId} does not match current step ${step.id}`);
        }
        await this.appendStepResult(root, task, plan, step, submitted);
      }
      return;
    }
    if (event.type === CoreStepEventType.ToolResultFailed) {
      const message = await this.config.store.appendMessage({
        id: this.createId('msg'),
        sessionId: root.sessionId,
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
        metadata: { planId: plan.id, stepId: step.id },
      });
      await this.emit({
        type: AgentSessionPatchType.ToolResultFailed,
        sessionId: root.sessionId,
        message,
      });
      return;
    }
    if (event.type === CoreStepEventType.ToolInputRequired) {
      const request = await this.config.store.createInputRequest({
        id: this.createId('input'),
        sessionId: root.sessionId,
        taskId: task.id,
        source: event.request.source,
        resumeMode: event.request.resumeMode,
        prompt: event.request.prompt,
        input: event.request.input,
        title: event.request.title,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        now: this.now(),
      });
      await this.emit({
        type: AgentSessionPatchType.ToolInputRequired,
        sessionId: root.sessionId,
        request,
      });
    }
  }

  private async appendStepResult(
    root: AgentTask,
    task: AgentTask,
    plan: PlannerPlan,
    step: PlannerStep,
    result: SubmittedStepResult
  ): Promise<AgentMessage> {
    const message = await this.config.store.appendMessage({
      id: this.createId('msg'),
      sessionId: root.sessionId,
      taskId: task.id,
      role: 'assistant',
      channel: 'final',
      messageKind: 'step_result',
      visibility: 'ui',
      content: result.summary,
      createdAt: this.now(),
      metadata: {
        kind: 'step_result',
        planId: plan.id,
        stepId: step.id,
        result,
      },
    });
    await this.emit({
      type: AgentSessionPatchType.ModelOutputCompleted,
      sessionId: root.sessionId,
      outputId: `step_result_${step.id}`,
      message,
    });
    return message;
  }

  private async finalizePlan(
    root: AgentTask,
    plan: PlannerPlan,
    goal: string
  ): Promise<AgentRunResult> {
    try {
      const messages = await this.config.store.listMessages(root.sessionId);
      const stepResults = messages.filter(message => message.messageKind === 'step_result');
      const finalMessages = buildPlanFinalMessages({
        finalSystemPrompt: this.config.plannerFinalSystemPrompt ?? PLANNER_FINAL_SYSTEM_PROMPT,
        goal,
        now: this.getRuntimeNow(),
        plan,
        stepResults,
      });
      const final = await this.config.planner.completePlan({ messages: finalMessages });
      await this.recordModelCall(
        root,
        finalMessages,
        'planner.plan.finalize',
        final.usage,
        'planner.final'
      );
      const message = await this.config.store.appendMessage({
        id: this.createId('msg'),
        sessionId: root.sessionId,
        taskId: root.id,
        role: 'assistant',
        channel: 'final',
        messageKind: 'planner_final',
        visibility: 'ui',
        content: final.content,
        createdAt: this.now(),
        metadata: { kind: 'planner_final', planId: plan.id },
      });
      await this.emit({
        type: AgentSessionPatchType.ModelOutputCompleted,
        sessionId: root.sessionId,
        outputId: `planner_final_${plan.id}`,
        message,
      });
      const latestRoot = await this.requireTask(root.sessionId, root.id);
      const completed = latestRoot.status === 'completed'
        ? latestRoot
        : await this.transition(latestRoot, 'completed');
      return { sessionId: root.sessionId, taskId: root.id, status: completed.status };
    } catch (error) {
      return this.failTask(await this.requireTask(root.sessionId, root.id), asError(error));
    }
  }

  private async appendPlanMessage(root: AgentTask, plan: PlannerPlan): Promise<AgentMessage> {
    const content = [
      plan.title,
      ...plan.steps.map((step, index) => `${index + 1}. ${step.title}`),
    ].join('\n');
    const message = await this.config.store.appendMessage({
      id: this.createId('msg'),
      sessionId: root.sessionId,
      taskId: root.id,
      role: 'assistant',
      channel: 'normal',
      messageKind: 'plan',
      visibility: 'ui',
      content,
      createdAt: this.now(),
      metadata: { kind: 'plan', planId: plan.id, plan },
    });
    await this.emit({
      type: AgentSessionPatchType.PlannerPlanCreated,
      sessionId: root.sessionId,
      message,
    });
    return message;
  }

  private async appendInternalPrompt(
    task: AgentTask,
    content: string,
    metadata: Record<string, unknown>
  ): Promise<AgentMessage> {
    return this.config.store.appendMessage({
      id: this.createId('msg'),
      sessionId: task.sessionId,
      taskId: task.id,
      role: 'system',
      messageKind: 'system_prompt',
      visibility: 'internal',
      content,
      createdAt: this.now(),
      metadata: { kind: 'system_prompt', visibility: 'internal', ...metadata },
    });
  }

  private async persistInputAnswer(
    request: AgentInputRequest,
    task: AgentTask,
    value: unknown
  ): Promise<void> {
    const messageId = this.createId('msg');
    const answeredAt = this.now();
    if (request.resumeMode === 'answer_as_tool_result') {
      if (!request.toolCallId || !request.toolName) {
        throw new Error(`Input request ${request.id} is missing tool call metadata`);
      }
      const message = await this.config.store.appendMessage({
        id: messageId,
        sessionId: request.sessionId,
        taskId: task.id,
        role: 'tool',
        content: stringify(value),
        toolResult: {
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          status: 'completed',
          result: value,
        },
        createdAt: this.now(),
        metadata: { inputRequestId: request.id, stepId: task.metadata?.stepId },
      });
      await this.emit({
        type: AgentSessionPatchType.ToolResultCompleted,
        sessionId: request.sessionId,
        message,
      });
      await this.config.store.answerInputRequest(request.id, {
        value,
        messageId,
        answeredAt,
      });
      return;
    }
    const message = await this.config.store.appendMessage({
      id: messageId,
      sessionId: request.sessionId,
      taskId: task.id,
      role: 'user',
      content: stringify(value),
      createdAt: this.now(),
      metadata: { inputRequestId: request.id, source: 'input_request_answer' },
    });
    await this.emit({
      type: AgentSessionPatchType.UserMessageCreated,
      sessionId: request.sessionId,
      message,
    });
    await this.config.store.answerInputRequest(request.id, {
      value,
      messageId,
      answeredAt,
    });
  }

  private async transition(
    task: AgentTask,
    status: 'running' | 'waiting_user_input' | 'resuming' | 'completed' | 'failed',
    options: { requests?: AgentInputRequest[]; error?: Error } = {}
  ): Promise<AgentTask> {
    const requestIds = options.requests?.map(request => request.id);
    const updated = await this.config.store.updateTask(task.id, transitionTaskStatus(task, status, {
      now: this.now(),
      waitingRequestId: requestIds?.[0],
      waitingRequestIds: requestIds,
      error: options.error ? {
        message: options.error.message,
        details: { name: options.error.name, stack: options.error.stack },
        failedAt: this.now(),
      } : undefined,
    }));
    await this.emit({
      type: AgentSessionPatchType.TaskStatusChanged,
      sessionId: task.sessionId,
      task: updated,
    });
    return updated;
  }

  private async resumeTask(task: AgentTask): Promise<AgentTask> {
    const resuming = task.status === 'waiting_user_input'
      ? await this.transition(task, 'resuming')
      : task;
    return resuming.status === 'resuming'
      ? this.transition(resuming, 'running')
      : resuming;
  }

  private async updateWaitingTask(task: AgentTask, requests: AgentInputRequest[]): Promise<AgentTask> {
    if (task.status === 'waiting_user_input') {
      const requestIds = requests.map(request => request.id);
      const updated = await this.config.store.updateTask(task.id, {
        ...task,
        waitingRequestId: requestIds[0],
        waitingRequestIds: requestIds,
        updatedAt: this.now(),
      });
      await this.emit({
        type: AgentSessionPatchType.TaskStatusChanged,
        sessionId: task.sessionId,
        task: updated,
      });
      return updated;
    }
    return this.transition(task, 'waiting_user_input', { requests });
  }

  private async failTask(task: AgentTask, error: Error): Promise<AgentRunResult> {
    const latest = await this.requireTask(task.sessionId, task.id);
    if (latest.status === 'failed' || latest.status === 'completed' || latest.status === 'cancelled') {
      return { sessionId: latest.sessionId, taskId: latest.id, status: latest.status };
    }
    const failed = await this.transition(latest, 'failed', { error });
    return { sessionId: failed.sessionId, taskId: failed.id, status: failed.status };
  }

  private async loadPlan(sessionId: string, rootTaskId: string): Promise<PlannerPlan> {
    const messages = await this.config.store.listMessages(sessionId);
    for (const message of [...messages].reverse()) {
      if (message.taskId !== rootTaskId || message.messageKind !== 'plan') {
        continue;
      }
      const plan = message.metadata?.plan;
      if (isPlannerPlan(plan)) {
        return plan;
      }
    }
    throw new Error(`Planner plan not found for task: ${rootTaskId}`);
  }

  private async loadStepResult(
    sessionId: string,
    taskId: string,
    stepId: string
  ): Promise<AgentMessage | undefined> {
    return (await this.config.store.listMessages(sessionId))
      .filter(message =>
        message.taskId === taskId
        && message.messageKind === 'step_result'
        && message.metadata?.stepId === stepId
      )
      .at(-1);
  }

  private readGoal(root: AgentTask): string {
    const goal = root.metadata?.goal;
    if (typeof goal !== 'string' || !goal.trim()) {
      throw new Error(`Planner root task is missing goal: ${root.id}`);
    }
    return goal;
  }

  private readStepId(task: AgentTask): string {
    const stepId = task.metadata?.stepId;
    if (typeof stepId !== 'string' || !stepId) {
      throw new Error(`Planner step task is missing stepId: ${task.id}`);
    }
    return stepId;
  }

  private async requireTask(sessionId: string, taskId: string): Promise<AgentTask> {
    const task = (await this.config.store.listTasks(sessionId)).find(item => item.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private async requireInputRequest(sessionId: string, requestId: string): Promise<AgentInputRequest> {
    const request = (await this.config.store.listInputRequests(sessionId))
      .find(item => item.id === requestId);
    if (!request) {
      throw new Error(`Input request not found: ${requestId}`);
    }
    if (request.status !== 'pending') {
      throw new Error(`Input request is not pending: ${requestId}`);
    }
    return request;
  }

  private async listPendingRequests(sessionId: string, taskId: string): Promise<AgentInputRequest[]> {
    return (await this.config.store.listInputRequests(sessionId))
      .filter(request => request.taskId === taskId && request.status === 'pending');
  }

  private waitingResult(
    sessionId: string,
    rootTaskId: string,
    requests: AgentInputRequest[]
  ): AgentRunResult {
    const waitingRequestIds = requests.map(request => request.id);
    return {
      sessionId,
      taskId: rootTaskId,
      status: 'waiting_user_input',
      waitingRequestId: waitingRequestIds[0],
      waitingRequestIds,
    };
  }

  private async ensureSession(sessionId: string): Promise<void> {
    if (!await this.config.store.getSession(sessionId)) {
      await this.config.store.createSession({
        id: sessionId,
        mode: 'planner_react',
        now: this.now(),
      });
    }
  }

  private getRuntimeNow(): PlannerRuntimeNow {
    const timeZone = this.config.timeZone ?? 'Asia/Shanghai';
    return {
      currentDate: new Date(this.now()).toLocaleDateString('en-CA', { timeZone }),
      timeZone,
    };
  }

  private async buildVisibleSummary(sessionId: string, excludeMessageId?: string): Promise<string | undefined> {
    const visible = (await this.config.store.listMessages(sessionId))
      .filter(message => message.visibility !== 'internal')
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .filter(message => message.id !== excludeMessageId)
      .slice(-12)
      .map(message => `${message.role}: ${message.content}`)
      .join('\n');
    return visible ? visible.slice(-6000) : undefined;
  }

  private async recordModelCall(
    task: AgentTask,
    messages: BaseMessage[],
    purpose: AgentModelCallPurpose,
    usage: AgentModelTokenUsage | undefined,
    resultType: AgentModelCallResultType,
    outputId?: string,
    outputChannel?: string,
    toolNames: string[] = []
  ): Promise<void> {
    const systemText = messageText(messages[0]);
    const remainingText = messages.slice(1).map(messageText).join('\n');
    const estimatedInputTokens = this.tokenEstimator.countText(
      messages.map(messageText).join('\n')
    );
    const build = await this.config.store.createContextBuild({
      id: this.createId('ctx_build'),
      sessionId: task.sessionId,
      taskId: task.id,
      parentTaskId: task.parentTaskId,
      taskKind: task.kind,
      executor: task.executor,
      model: this.config.modelName ?? 'unknown',
      callPurpose: purpose,
      strategy: 'full',
      maxContextTokens: DEFAULT_TOKEN_BUDGET.maxContextTokens,
      reservedOutputTokens: DEFAULT_TOKEN_BUDGET.reservedOutputTokens,
      estimatedInputTokens,
      breakdown: {
        system: systemText ? this.tokenEstimator.countText(systemText) : undefined,
        recentMessages: remainingText ? this.tokenEstimator.countText(remainingText) : undefined,
        reservedOutput: DEFAULT_TOKEN_BUDGET.reservedOutputTokens,
      },
      metadata: {
        planId: task.metadata?.planId,
        stepId: task.metadata?.stepId,
      },
      now: this.now(),
    });
    await this.config.store.completeContextBuild(build.id, {
      usage: usage ?? { source: 'unavailable' },
      outputId,
      outputChannel,
      resultType,
      toolCallCount: toolNames.length,
      toolNames,
      completedAt: this.now(),
    });
    const stats = await this.config.store.getSessionTokenStats(task.sessionId);
    if (stats) {
      await this.emit({
        type: AgentSessionPatchType.ContextUsageUpdated,
        sessionId: task.sessionId,
        stats,
      });
    }
  }

  private emit(patch: AgentSessionPatch): Promise<void> {
    return this.events.emit(patch);
  }
}

function parseSubmittedStepResult(value: unknown): SubmittedStepResult | null {
  if (!isRecord(value) || value.type !== 'step_result_submitted' || typeof value.summary !== 'string' || !value.summary.trim()) {
    return null;
  }
  return value as unknown as SubmittedStepResult;
}

function isPlannerPlan(value: unknown): value is PlannerPlan {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.title === 'string'
    && Array.isArray(value.steps)
    && value.steps.every(step => isRecord(step)
      && typeof step.id === 'string'
      && typeof step.title === 'string'
      && typeof step.instruction === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function messageText(message: BaseMessage | undefined): string {
  if (!message) {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  return JSON.stringify(message.content);
}
