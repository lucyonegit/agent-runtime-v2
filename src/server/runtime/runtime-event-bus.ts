import type { MessageEvent } from '@nestjs/common';
import { EMPTY, Observable, Subject } from 'rxjs';
import type { AgentRealtimeEvent } from '../../domain/index.js';
import type { RuntimeEventPublisher } from '../../runtime/events/runtime-event-writer.js';

export interface RuntimeEventBusOptions {
  readSessionRevision?: (sessionId: string) => Promise<number | undefined>;
  revisionPollIntervalMs?: number;
}

export class RuntimeEventBus implements RuntimeEventPublisher {
  readonly #subjects = new Map<string, Subject<MessageEvent>>();
  readonly #closedSessions = new Set<string>();

  constructor(private readonly options: RuntimeEventBusOptions = {}) {}

  publish(event: AgentRealtimeEvent): void {
    if (this.#closedSessions.has(event.sessionId)) return;
    this.#subject(event.sessionId).next({
      type: event.type,
      id: event.type === 'message.delta' || event.type === 'message.discarded'
        ? event.eventId
        : undefined,
      data: event,
    });
  }

  events(sessionId: string): Observable<MessageEvent> {
    if (this.#closedSessions.has(sessionId)) return EMPTY;
    const events = this.#subject(sessionId);
    const revisionReader = this.options.readSessionRevision;
    if (!revisionReader) return events.asObservable();
    const pollIntervalMs = this.options.revisionPollIntervalMs
      ?? DEFAULT_REVISION_POLL_INTERVAL_MS;
    return new Observable(subscriber => {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lastRevision: number | undefined;
      const eventSubscription = events.subscribe(subscriber);
      const poll = async (): Promise<void> => {
        try {
          const revision = await revisionReader(sessionId);
          if (!stopped && !subscriber.closed && revision !== undefined && revision !== lastRevision) {
            lastRevision = revision;
            subscriber.next({
              type: 'session.revision',
              id: `session-revision:${revision}`,
              data: { type: 'session.revision', sessionId, revision } satisfies AgentRealtimeEvent,
            });
          }
        } catch {
          // A later poll or the reconnect snapshot can restore convergence.
        } finally {
          if (!stopped && !subscriber.closed) {
            timer = setTimeout(() => { void poll(); }, pollIntervalMs);
          }
        }
      };
      void poll();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        eventSubscription.unsubscribe();
      };
    });
  }

  openSession(sessionId: string): void {
    this.#closedSessions.delete(sessionId);
  }

  closeSession(sessionId: string): void {
    this.#subjects.get(sessionId)?.complete();
    this.#subjects.delete(sessionId);
    this.#closedSessions.add(sessionId);
  }

  #subject(sessionId: string): Subject<MessageEvent> {
    let subject = this.#subjects.get(sessionId);
    if (!subject) {
      subject = new Subject<MessageEvent>();
      this.#subjects.set(sessionId, subject);
    }
    return subject;
  }
}

const DEFAULT_REVISION_POLL_INTERVAL_MS = 5_000;
