import type { AgentJob } from '../../domain/index.js';
import { isTerminalJobStatus } from '../../domain/job.js';
import type { TurnBundle } from './context-material.js';
import { messagesInGroup, type MessageGroup } from './message-group-builder.js';

export class TurnBundleBuilder {
  build(input: {
    sessionId: string;
    jobs: AgentJob[];
    groups: MessageGroup[];
  }): TurnBundle[] {
    const jobsById = new Map(input.jobs.map(job => [job.id, job]));
    const rootByJobId = new Map<string, string>();
    const rootFor = (jobId: string): string => {
      const cached = rootByJobId.get(jobId);
      if (cached) return cached;
      const visited = new Set<string>();
      let current = jobsById.get(jobId);
      while (current?.retryOfJobId && jobsById.has(current.retryOfJobId)) {
        if (visited.has(current.id)) break;
        visited.add(current.id);
        current = jobsById.get(current.retryOfJobId);
      }
      const root = current?.id ?? jobId;
      for (const id of visited) rootByJobId.set(id, root);
      rootByJobId.set(jobId, root);
      return root;
    };
    const groupsByRoot = new Map<string, MessageGroup[]>();
    for (const group of input.groups) {
      const first = messagesInGroup(group)[0];
      if (!first) continue;
      const root = rootFor(first.jobId);
      const values = groupsByRoot.get(root) ?? [];
      values.push(group);
      groupsByRoot.set(root, values);
    }

    return [...groupsByRoot.entries()].map(([rootJobId, groups]) => {
      const orderedGroups = [...groups].sort((left, right) => (
        firstRow(left) - firstRow(right) || left.id.localeCompare(right.id)
      ));
      const jobIds = input.jobs
        .filter(job => rootFor(job.id) === rootJobId)
        .sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id))
        .map(job => job.id);
      const lineageJobs = jobIds.map(id => jobsById.get(id)).filter((job): job is AgentJob => !!job);
      const rows = orderedGroups.flatMap(messagesInGroup).map(message => message.rowId);
      return {
        id: `turn:${rootJobId}`,
        type: 'turn',
        sessionId: input.sessionId,
        rootJobId,
        jobIds,
        terminal: lineageJobs.length > 0 && lineageJobs.every(job => isTerminalJobStatus(job.status)),
        sourceRowIdStart: Math.min(...rows),
        sourceRowIdEnd: Math.max(...rows),
        groups: orderedGroups,
      } satisfies TurnBundle;
    }).sort((left, right) => (
      left.sourceRowIdStart - right.sourceRowIdStart || left.id.localeCompare(right.id)
    ));
  }
}

function firstRow(group: MessageGroup): number {
  return Math.min(...messagesInGroup(group).map(message => message.rowId));
}
