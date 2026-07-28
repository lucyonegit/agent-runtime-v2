import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  type MessageEvent,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import { interval, map, merge, type Observable } from 'rxjs';
import { AgentRuntime } from '../../orchestration/agent-runtime.js';
import { RuntimeEventBus } from '../runtime/runtime-event-bus.js';

@Controller()
export class AgentController {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly events: RuntimeEventBus
  ) {}

  @Post('sessions')
  createSession(@Body() body: { title?: string }) {
    return this.runtime.createSession(body ?? {});
  }

  @Get('sessions')
  listSessions() {
    return this.runtime.listSessions();
  }

  @Get('sessions/:sessionId/view')
  getSessionView(@Param('sessionId') sessionId: string) {
    return this.runtime.getSessionView(sessionId);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  async deleteSession(@Param('sessionId') sessionId: string): Promise<void> {
    await this.runtime.deleteSession(sessionId);
    this.events.closeSession(sessionId);
  }

  @Post('sessions/:sessionId/tasks')
  createTask(
    @Param('sessionId') sessionId: string,
    @Body() body: { message: string; clientRequestId: string }
  ) {
    assertNonEmpty(body?.message, 'message');
    assertNonEmpty(body?.clientRequestId, 'clientRequestId');
    return this.runtime.createTask({ sessionId, ...body });
  }

  @Post('tasks/:taskId/cancel')
  cancelTask(
    @Param('taskId') taskId: string,
    @Body() body: { expectedVersion: number }
  ) {
    return this.runtime.cancelTask(taskId, body.expectedVersion);
  }

  @Post('tasks/:taskId/retry')
  retryTask(
    @Param('taskId') taskId: string,
    @Body() body: { clientRequestId: string }
  ) {
    assertNonEmpty(body?.clientRequestId, 'clientRequestId');
    return this.runtime.retryTask({ sourceTaskId: taskId, ...body });
  }

  @Post('tasks/:taskId/continue-as-new')
  continueAsNewTask(
    @Param('taskId') taskId: string,
    @Body() body: { clientRequestId: string; message: string }
  ) {
    assertNonEmpty(body?.clientRequestId, 'clientRequestId');
    assertNonEmpty(body?.message, 'message');
    return this.runtime.continueAsNewTask({ sourceTaskId: taskId, ...body });
  }

  @Post('tasks/:taskId/resume')
  resumeTask(
    @Param('taskId') taskId: string,
    @Body() body: { expectedVersion: number }
  ) {
    return this.runtime.resumeTask(taskId, body.expectedVersion);
  }

  @Post('user-input-requests/:requestId/answer')
  answerUserInputRequest(
    @Param('requestId') requestId: string,
    @Body() body: { expectedVersion: number; clientAnswerId: string; answer: unknown }
  ) {
    assertNonEmpty(body?.clientAnswerId, 'clientAnswerId');
    return this.runtime.answerUserInputRequest({ requestId, ...body });
  }

  @Sse('sessions/:sessionId/events')
  sessionEvents(@Param('sessionId') sessionId: string): Observable<MessageEvent> {
    return merge(
      this.events.events(sessionId),
      interval(SSE_HEARTBEAT_INTERVAL_MS).pipe(map(() => ({ data: '' })))
    );
  }
}

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
