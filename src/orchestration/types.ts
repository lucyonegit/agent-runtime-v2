import type { AgentTask } from '../domain/index.js';

export interface AgentRunResult {
  sessionId: string;
  taskId: string;
  status: AgentTask['status'];
  waitingRequestId?: string;
  waitingRequestIds?: string[];
}

export type IdFactory = (prefix: string) => string;
export type Clock = () => number;

export function defaultIdFactory(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
