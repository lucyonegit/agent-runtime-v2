import type { MessageEvent } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { AgentRealtimeEvent } from '../../domain/index.js';
import type { RuntimeEventPublisher } from '../../runtime/runtime-event-writer.js';

export class RuntimeEventBus implements RuntimeEventPublisher {
  readonly #subjects = new Map<string, Subject<MessageEvent>>();

  publish(event: AgentRealtimeEvent): void {
    this.#subject(event.sessionId).next({
      type: event.type,
      id: event.type === 'message.delta' ? event.eventId : undefined,
      data: event,
    });
  }

  events(sessionId: string): Observable<MessageEvent> {
    return this.#subject(sessionId).asObservable();
  }

  closeSession(sessionId: string): void {
    this.#subjects.get(sessionId)?.complete();
    this.#subjects.delete(sessionId);
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
