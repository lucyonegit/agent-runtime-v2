import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionSnapshot, AgentStore } from '../src/storage/agent-store.js';
import { SessionView } from '../src/view/session-view.js';

describe('SessionView durable snapshot', () => {
  it('builds the View from one storage snapshot and samples live processes separately', async () => {
    const snapshot = emptySnapshot();
    const loadSnapshot = vi.fn(async () => snapshot);
    const listSessionProcesses = vi.fn(async () => []);
    const view = new SessionView(
      { sessions: { loadSnapshot } } as unknown as AgentStore,
      { nowMs: () => 1_000 },
      { listSessionProcesses }
    );

    await expect(view.load('session_1')).resolves.toMatchObject({
      generatedAtMs: 1_000,
      session: snapshot.session,
      tasks: [],
      messages: [],
      managedProcesses: [],
      timeline: { flat: [] },
    });
    expect(loadSnapshot).toHaveBeenCalledOnce();
    expect(loadSnapshot).toHaveBeenCalledWith('session_1');
    expect(listSessionProcesses).toHaveBeenCalledWith('session_1');
  });
});

function emptySnapshot(): AgentSessionSnapshot {
  return {
    session: {
      id: 'session_1',
      status: 'active',
      version: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    tasks: [],
    taskRuns: [],
    messages: [],
    toolCalls: [],
    artifacts: [],
    userInputRequests: [],
  };
}
