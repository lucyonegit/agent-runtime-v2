import type { MessageGroup } from './message-group.types.js';

export interface ContextMemoryV1 {
  schemaVersion: 1;
  coverage: {
    groupIds: string[];
    messageIds: string[];
    bundleIds: string[];
    jobIds: string[];
    sourceRowIdStart: number;
    sourceRowIdEnd: number;
  };
  memory: {
    userGoals: Record<string, unknown>[];
    constraints: Record<string, unknown>[];
    facts: Record<string, unknown>[];
    decisions: Record<string, unknown>[];
    completedActions: Record<string, unknown>[];
    failures: Record<string, unknown>[];
    artifacts: Record<string, unknown>[];
    unresolved: Record<string, unknown>[];
  };
}

export interface OrderedContextGroup {
  group: MessageGroup;
  bundleId: string;
}
