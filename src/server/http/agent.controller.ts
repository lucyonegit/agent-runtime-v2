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
import { ContextPreviewService } from '../debug/context-preview.service.js';
import { RuntimeEventBus } from '../runtime/runtime-event-bus.js';
import { ManagedProcessManager } from '../../tools/index.js';

@Controller()
export class AgentController {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly events: RuntimeEventBus,
    private readonly contextPreview: ContextPreviewService,
    private readonly managedProcesses: ManagedProcessManager
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

  @Get('sessions/:sessionId/context-preview')
  getContextPreview(@Param('sessionId') sessionId: string) {
    return this.contextPreview.preview(sessionId);
  }

  @Get('jobs/:jobId/context-preview')
  getJobContextPreview(@Param('jobId') jobId: string) {
    return this.contextPreview.previewJob(jobId);
  }

  @Get('model-calls/:modelCallId/context')
  getModelCallContext(@Param('modelCallId') modelCallId: string) {
    return this.contextPreview.previewModelCall(modelCallId);
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
    @Body() body: { message: string; clientRequestId: string }
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

  @Post('jobs/:jobId/resume')
  resumeJob(
    @Param('jobId') jobId: string,
    @Body() body: { expectedVersion: number }
  ) {
    return this.runtime.resumeJob(jobId, body.expectedVersion);
  }

  @Post('user-input-requests/:requestId/answer')
  answerUserInputRequest(
    @Param('requestId') requestId: string,
    @Body() body: { expectedVersion: number; clientAnswerId: string; answer: unknown }
  ) {
    assertNonEmpty(body?.clientAnswerId, 'clientAnswerId');
    return this.runtime.answerUserInputRequest({ requestId, ...body });
  }

  @Get('managed-processes/:processId')
  getManagedProcess(@Param('processId') processId: string) {
    return this.managedProcesses.getProcess(processId);
  }

  @Get('managed-processes/:processId/logs')
  async getManagedProcessLogs(@Param('processId') processId: string) {
    return { processId, logs: await this.managedProcesses.readLogs(processId) };
  }

  @Post('managed-processes/:processId/stop')
  stopManagedProcess(@Param('processId') processId: string) {
    return this.managedProcesses.stopProcess(processId);
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
