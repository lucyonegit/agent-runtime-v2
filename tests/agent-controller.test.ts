import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentController } from '../src/server/http/agent.controller.js';
import { RuntimeEventBus } from '../src/server/runtime/runtime-event-bus.js';

describe('AgentController SSE', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps an otherwise idle Session event stream alive', async () => {
    vi.useFakeTimers();
    const controller = new AgentController(
      null as never,
      new RuntimeEventBus()
    );
    const received: unknown[] = [];
    const subscription = controller.sessionEvents('session_1').subscribe(event => {
      received.push(event);
    });

    await vi.advanceTimersByTimeAsync(15_000);

    expect(received).toEqual([{ data: '' }]);
    subscription.unsubscribe();
  });

  it('does not recreate an event Subject from late publishes after Session deletion', () => {
    const events = new RuntimeEventBus();
    const received: unknown[] = [];
    let completed = false;

    events.closeSession('session_1');
    events.publish({ type: 'plan.cleared', sessionId: 'session_1', taskId: 'task_1' });
    events.events('session_1').subscribe({
      next: event => received.push(event),
      complete: () => { completed = true; },
    });

    expect(received).toEqual([]);
    expect(completed).toBe(true);

    events.openSession('session_1');
    const reopened = events.events('session_1').subscribe(event => received.push(event.data));
    events.publish({ type: 'plan.cleared', sessionId: 'session_1', taskId: 'task_2' });
    expect(received).toEqual([
      { type: 'plan.cleared', sessionId: 'session_1', taskId: 'task_2' },
    ]);
    reopened.unsubscribe();
  });

  it('emits changed durable Session revisions and stops polling after close', async () => {
    vi.useFakeTimers();
    let revision = 3;
    const readSessionRevision = vi.fn(async () => revision);
    const events = new RuntimeEventBus({
      readSessionRevision,
      revisionPollIntervalMs: 100,
    });
    const received: unknown[] = [];
    events.events('session_1').subscribe(event => received.push(event.data));

    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([
      { type: 'session.revision', sessionId: 'session_1', revision: 3 },
    ]);

    revision = 4;
    await vi.advanceTimersByTimeAsync(100);
    expect(received.at(-1)).toEqual({
      type: 'session.revision',
      sessionId: 'session_1',
      revision: 4,
    });

    events.closeSession('session_1');
    const callsAtClose = readSessionRevision.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(readSessionRevision).toHaveBeenCalledTimes(callsAtClose);
  });

  it('completes the SSE stream and heartbeat when a Session closes', () => {
    const events = new RuntimeEventBus();
    const controller = new AgentController(null as never, events);
    let completed = false;
    const subscription = controller.sessionEvents('session_1').subscribe({
      complete: () => { completed = true; },
    });

    events.closeSession('session_1');

    expect(completed).toBe(true);
    expect(subscription.closed).toBe(true);
  });
});
