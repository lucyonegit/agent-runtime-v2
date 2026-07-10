import { Injectable, type MessageEvent } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { map } from 'rxjs/operators';
import type { AgentSessionPatch } from '../../domain/index.js';

interface SessionPatchEnvelope {
  sessionId: string;
  patch: AgentSessionPatch;
}

@Injectable()
export class SseEventBus {
  private readonly subjects = new Map<string, Subject<SessionPatchEnvelope>>();

  publish(sessionId: string, patch: AgentSessionPatch): void {
    this.subject(sessionId).next({ sessionId, patch });
  }

  observe(sessionId: string): Observable<MessageEvent> {
    return this.subject(sessionId).asObservable().pipe(
      map(event => ({
        type: event.patch.type,
        data: event.patch,
      }))
    );
  }

  close(sessionId: string): void {
    const subject = this.subjects.get(sessionId);
    if (!subject) {
      return;
    }
    subject.complete();
    this.subjects.delete(sessionId);
  }

  private subject(sessionId: string): Subject<SessionPatchEnvelope> {
    const existing = this.subjects.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Subject<SessionPatchEnvelope>();
    this.subjects.set(sessionId, created);
    return created;
  }
}
