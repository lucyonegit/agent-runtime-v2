import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { ContextBuilder } from '../context/index.js';
import type { PlannerPlan, PlannerStep } from '../core/index.js';
import type { AgentMessage } from '../domain/index.js';

export interface PlannerRuntimeNow {
  currentDate: string;
  timeZone: string;
}

export function buildPlannerRouteMessages(input: {
  routerSystemPrompt: string;
  goal: string;
  now: PlannerRuntimeNow;
  visibleSummary?: string;
}): BaseMessage[] {
  return [
    new SystemMessage(input.routerSystemPrompt),
    new HumanMessage(formatGoalContext(input)),
  ];
}

export function buildPlanCreateMessages(input: {
  plannerSystemPrompt: string;
  goal: string;
  now: PlannerRuntimeNow;
  visibleSummary?: string;
}): BaseMessage[] {
  return [
    new SystemMessage(input.plannerSystemPrompt),
    new HumanMessage(formatGoalContext(input)),
  ];
}

export function buildPlanStepMessages(input: {
  reactSystemPrompt: string;
  goal: string;
  now: PlannerRuntimeNow;
  plan: PlannerPlan;
  currentStep: PlannerStep;
  previousStepResults: AgentMessage[];
  currentRuntimeTail: AgentMessage[];
  contextBuilder: ContextBuilder;
}): BaseMessage[] {
  const brief = [
    `当前日期：${input.now.currentDate}`,
    `当前时区：${input.now.timeZone}`,
    `用户原始目标：${input.goal}`,
    `当前计划：\n${formatPlan(input.plan)}`,
    `已完成步骤结果：\n${formatStepResults(input.plan, input.previousStepResults)}`,
    `现在只执行当前步骤：${input.currentStep.id}`,
    `步骤标题：${input.currentStep.title}`,
    `步骤指令：${input.currentStep.instruction}`,
    '不要执行其他步骤。完成当前步骤时必须调用 submit_step_result。',
  ].join('\n\n');

  const runtimeTail = input.currentRuntimeTail
    .filter(message => message.role === 'assistant' || message.role === 'tool')
    .filter(message => message.messageKind !== 'step_result')
    .sort(compareMessages);

  return [
    new SystemMessage(input.reactSystemPrompt),
    new HumanMessage(brief),
    ...input.contextBuilder.build(runtimeTail),
  ];
}

export function buildPlanFinalMessages(input: {
  finalSystemPrompt: string;
  goal: string;
  now: PlannerRuntimeNow;
  plan: PlannerPlan;
  stepResults: AgentMessage[];
}): BaseMessage[] {
  return [
    new SystemMessage(input.finalSystemPrompt),
    new HumanMessage([
      `当前日期：${input.now.currentDate}`,
      `当前时区：${input.now.timeZone}`,
      `用户原始目标：${input.goal}`,
      `计划：\n${formatPlan(input.plan)}`,
      `步骤执行结果：\n${formatStepResults(input.plan, input.stepResults)}`,
    ].join('\n\n')),
  ];
}

function formatGoalContext(input: {
  goal: string;
  now: PlannerRuntimeNow;
  visibleSummary?: string;
}): string {
  return [
    `当前日期：${input.now.currentDate}`,
    `当前时区：${input.now.timeZone}`,
    `用户目标：${input.goal}`,
    input.visibleSummary?.trim()
      ? `可见会话摘要：${input.visibleSummary.trim()}`
      : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function formatPlan(plan: PlannerPlan): string {
  return [
    `计划 ID：${plan.id}`,
    `计划标题：${plan.title}`,
    ...plan.steps.map((step, index) => [
      `${index + 1}. [${step.id}] ${step.title}`,
      `   ${step.instruction}`,
    ].join('\n')),
  ].join('\n');
}

function formatStepResults(plan: PlannerPlan, messages: AgentMessage[]): string {
  const resultByStepId = new Map<string, AgentMessage>();
  for (const message of [...messages].sort(compareMessages)) {
    const stepId = typeof message.metadata?.stepId === 'string'
      ? message.metadata.stepId
      : undefined;
    if (stepId && isStepResult(message)) {
      resultByStepId.set(stepId, message);
    }
  }

  const lines = plan.steps.flatMap(step => {
    const result = resultByStepId.get(step.id);
    return result ? [`[${step.id}] ${step.title}\n${result.content}`] : [];
  });
  return lines.length > 0 ? lines.join('\n\n') : '暂无已完成步骤。';
}

function isStepResult(message: AgentMessage): boolean {
  return message.messageKind === 'step_result' || message.metadata?.kind === 'step_result';
}

function compareMessages(left: AgentMessage, right: AgentMessage): number {
  return left.rowId - right.rowId || left.createdAt - right.createdAt;
}
