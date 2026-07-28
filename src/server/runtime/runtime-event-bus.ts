import type { MessageEvent } from '@nestjs/common';
import { EMPTY, Observable, Subject } from 'rxjs';
import type { AgentRealtimeEvent } from '../../domain/index.js';
import type { RuntimeEventPublisher } from '../../runtime/events/runtime-event-writer.js';

export class RuntimeEventBus implements RuntimeEventPublisher {
  readonly #subjects = new Map<string, Subject<MessageEvent>>();
  readonly #closedSessions = new Set<string>();

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
    return this.#subject(sessionId).asObservable();
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
