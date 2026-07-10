import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import { AgentRuntime } from '../../orchestration/agent-runtime.js';
import { RuntimeEventBus } from '../runtime/runtime-event-bus.js';

@Controller()
export class AgentController {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly events: RuntimeEventBus
  ) {}

  @Post('sessions')
  createSession(@Body() body: { title?: string; mode?: 'agent' | 'code' }) {
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

  @Post('sessions/:sessionId/jobs')
  createJob(
    @Param('sessionId') sessionId: string,
    @Body() body: { message: string; projectId?: string; clientRequestId: string }
  ) {
    assertNonEmpty(body?.message, 'message');
    assertNonEmpty(body?.clientRequestId, 'clientRequestId');
    return this.runtime.createJob({ sessionId, ...body });
  }

  @Post('jobs/:jobId/cancel')
  cancelJob(
    @Param('jobId') jobId: string,
    @Body() body: { expectedVersion: number }
  ) {
    return this.runtime.cancelJob(jobId, body.expectedVersion);
  }

  @Post('jobs/:jobId/retry')
  retryJob(
    @Param('jobId') jobId: string,
    @Body() body: { clientRequestId: string; message?: string }
  ) {
    assertNonEmpty(body?.clientRequestId, 'clientRequestId');
    return this.runtime.retryJob({ failedJobId: jobId, ...body });
  }

  @Post('user-input-requests/:requestId/answer')
  answerInput(
    @Param('requestId') requestId: string,
    @Body() body: { expectedVersion: number; clientAnswerId: string; answer: unknown }
  ) {
    assertNonEmpty(body?.clientAnswerId, 'clientAnswerId');
    return this.runtime.answerInput({ requestId, ...body });
  }

  @Sse('sessions/:sessionId/events')
  sessionEvents(@Param('sessionId') sessionId: string) {
    return this.events.events(sessionId);
  }
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}
