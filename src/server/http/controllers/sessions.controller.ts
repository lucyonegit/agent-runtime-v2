import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Sse, type MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { AgentRuntimeService } from '../agent-runtime.service.js';
import { SseEventBus } from '../sse-event-bus.js';
import type { CreateSessionBody } from '../dto.js';

@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly runtime: AgentRuntimeService,
    private readonly events?: SseEventBus
  ) {}

  @Get()
  listSessions() {
    return this.runtime.listSessions();
  }

  @Post()
  createSession(@Body() body: CreateSessionBody) {
    return this.runtime.createSession(body ?? {});
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteSession(@Param('sessionId') sessionId: string) {
    return this.runtime.deleteSession(sessionId);
  }

  @Get(':sessionId/view')
  getSessionView(@Param('sessionId') sessionId: string) {
    return this.runtime.loadSessionView(sessionId);
  }

  @Get(':sessionId/context-usage')
  getSessionContextUsage(@Param('sessionId') sessionId: string) {
    return this.runtime.getSessionTokenStats(sessionId);
  }

  @Sse(':sessionId/events')
  observeSessionEvents(@Param('sessionId') sessionId: string): Observable<MessageEvent> {
    if (!this.events) {
      throw new Error('SSE event bus is not configured');
    }
    return this.events.observe(sessionId);
  }
}
