import { Controller, Get, Param } from '@nestjs/common';
import { ContextPreviewService } from '../debug/context-preview.service.js';

/** Authenticated, read-only projection used by the Web Context panel. */
@Controller()
export class AgentContextController {
  constructor(private readonly contextPreview: ContextPreviewService) {}

  @Get('sessions/:sessionId/context-preview')
  getSessionContextPreview(@Param('sessionId') sessionId: string) {
    return this.contextPreview.preview(sessionId);
  }
}
