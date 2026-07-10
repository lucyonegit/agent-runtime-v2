import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { AgentModelTokenUsage } from '../../domain/index.js';

export type PlannerRouteMode = 'direct_answer' | 'plan';

export interface PlannerRoute {
  mode: PlannerRouteMode;
  reason: string;
}

export interface PlannerStep {
  id: string;
  title: string;
  instruction: string;
}

export interface PlannerPlan {
  id: string;
  title: string;
  steps: PlannerStep[];
}

export interface PlannerModel {
  invoke(messages: BaseMessage[]): Promise<AIMessage>;
}

export interface PlannerCoreConfig {
  model: PlannerModel;
}

export interface PlannerCallResult<T> {
  usage?: AgentModelTokenUsage;
  value: T;
}

export class PlannerCore {
  constructor(private readonly config: PlannerCoreConfig) {}

  async routeGoal(input: { messages: BaseMessage[] }): Promise<{
    route: PlannerRoute;
    usage?: AgentModelTokenUsage;
  }> {
    const response = await this.config.model.invoke(input.messages);
    return {
      route: parseRoute(readText(response)),
      usage: readUsage(response),
    };
  }

  async createPlan(input: { messages: BaseMessage[] }): Promise<{
    plan: PlannerPlan;
    usage?: AgentModelTokenUsage;
  }> {
    const response = await this.config.model.invoke(input.messages);
    return {
      plan: parsePlan(readText(response)),
      usage: readUsage(response),
    };
  }

  async completePlan(input: { messages: BaseMessage[] }): Promise<{
    content: string;
    usage?: AgentModelTokenUsage;
  }> {
    const response = await this.config.model.invoke(input.messages);
    const content = readText(response).trim();
    if (!content) {
      throw new Error('Planner final output is empty');
    }
    return {
      content,
      usage: readUsage(response),
    };
  }
}

function parseRoute(content: string): PlannerRoute {
  const value = parseJsonObject(content, 'Planner route');
  const mode = value.mode;
  if (mode !== 'direct_answer' && mode !== 'plan') {
    throw new Error('Planner route mode must be direct_answer or plan');
  }
  const reason = readRequiredString(value, 'reason', 'Planner route');
  return { mode, reason };
}

function parsePlan(content: string): PlannerPlan {
  const value = parseJsonObject(content, 'Planner plan');
  const id = readRequiredString(value, 'id', 'Planner plan');
  const title = readRequiredString(value, 'title', 'Planner plan');
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 5) {
    throw new Error('Planner plan must contain between 1 and 5 steps');
  }

  const stepIds = new Set<string>();
  const steps = value.steps.map((candidate, index): PlannerStep => {
    if (!isRecord(candidate)) {
      throw new Error(`Planner step ${index + 1} must be an object`);
    }
    const step = {
      id: readRequiredString(candidate, 'id', `Planner step ${index + 1}`),
      title: readRequiredString(candidate, 'title', `Planner step ${index + 1}`),
      instruction: readRequiredString(candidate, 'instruction', `Planner step ${index + 1}`),
    };
    if (stepIds.has(step.id)) {
      throw new Error(`Planner returned duplicate step id: ${step.id}`);
    }
    stepIds.add(step.id);
    return step;
  });

  return { id, title, steps };
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  const normalized = content.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = normalized.indexOf('{');
  const end = normalized.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error(`${label} did not contain a JSON object`);
  }
  try {
    const value: unknown = JSON.parse(normalized.slice(start, end + 1));
    if (!isRecord(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${details}`);
  }
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  label: string
): string {
  const result = value[key];
  if (typeof result !== 'string' || !result.trim()) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return result.trim();
}

function readText(message: AIMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .map(block => {
      if (typeof block === 'string') {
        return block;
      }
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      return '';
    })
    .join('');
}

function readUsage(message: AIMessage): AgentModelTokenUsage | undefined {
  const usage = message.usage_metadata;
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    source: 'provider',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
