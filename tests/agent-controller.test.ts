import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentController } from '../src/server/http/agent.controller.js';
import { RuntimeEventBus } from '../src/server/runtime/runtime-event-bus.js';

describe('AgentController SSE', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps an otherwise idle Session event stream alive', async () => {
    vi.useFakeTimers();
    const controller = new AgentController(
      null as never,
      new RuntimeEventBus(),
      null as never,
      null as never
    );
    const received: unknown[] = [];
    const subscription = controller.sessionEvents('session_1').subscribe(event => {
      received.push(event);
    });

    await vi.advanceTimersByTimeAsync(15_000);

    expect(received).toEqual([{ data: '' }]);
    subscription.unsubscribe();
  });
});
