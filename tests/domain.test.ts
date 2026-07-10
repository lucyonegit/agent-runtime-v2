import { describe, expect, it } from 'vitest';
import {
  createTask,
  isTerminalTaskStatus,
  transitionTaskStatus,
  type AgentTask,
} from '../src/domain/index.js';

describe('domain task state machine', () => {
  it('creates a task in created status with timestamps', () => {
    const task = createTask({
      id: 'task_1',
      sessionId: 'session_1',
      kind: 'react',
      now: 100,
    });

    expect(task).toMatchObject({
      id: 'task_1',
      sessionId: 'session_1',
      kind: 'react',
      status: 'created',
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it('allows waiting and resume transitions', () => {
    const created = createTask({
      id: 'task_1',
      sessionId: 'session_1',
      kind: 'react',
      now: 100,
    });

    const running = transitionTaskStatus(created, 'running', { now: 110 });
    const waiting = transitionTaskStatus(running, 'waiting_user_input', {
      now: 120,
      waitingRequestId: 'input_1',
    });
    const resuming = transitionTaskStatus(waiting, 'resuming', { now: 130 });
    const runningAgain = transitionTaskStatus(resuming, 'running', { now: 140 });
    const completed = transitionTaskStatus(runningAgain, 'completed', { now: 150 });

    expect(waiting.waitingRequestId).toBe('input_1');
    expect(waiting.waitingRequestIds).toEqual(['input_1']);
    expect(resuming.waitingRequestId).toBeUndefined();
    expect(resuming.waitingRequestIds).toBeUndefined();
    expect(completed.completedAt).toBe(150);
    expect(isTerminalTaskStatus(completed.status)).toBe(true);
  });

  it('tracks multiple waiting input requests on a task', () => {
    const created = createTask({
      id: 'task_1',
      sessionId: 'session_1',
      kind: 'react',
      now: 100,
    });
    const running = transitionTaskStatus(created, 'running', { now: 110 });

    const waiting = transitionTaskStatus(running, 'waiting_user_input', {
      now: 120,
      waitingRequestIds: ['input_1', 'input_2'],
    });

    expect(waiting).toMatchObject({
      status: 'waiting_user_input',
      waitingRequestId: 'input_1',
      waitingRequestIds: ['input_1', 'input_2'],
    });
  });

  it('rejects invalid or terminal transitions', () => {
    const task: AgentTask = createTask({
      id: 'task_1',
      sessionId: 'session_1',
      kind: 'react',
      now: 100,
    });

    expect(() => transitionTaskStatus(task, 'completed', { now: 110 })).toThrow(
      'Invalid task status transition'
    );

    const cancelled = transitionTaskStatus(task, 'cancelled', { now: 120 });
    expect(() => transitionTaskStatus(cancelled, 'running', { now: 130 })).toThrow(
      'Cannot transition terminal task'
    );
  });
});
