import { Controller, Get, Param } from '@nestjs/common';
import { ContextPreviewService } from '../debug/context-preview.service.js';

@Controller()
export class AgentDebugController {
  constructor(private readonly contextPreview: ContextPreviewService) {}

  @Get('tasks/:taskId/context-preview')
  getTaskContextPreview(@Param('taskId') taskId: string) {
    return this.contextPreview.previewTask(taskId);
  }

  @Get('model-calls/:modelCallId/context')
  getModelCallContext(@Param('modelCallId') modelCallId: string) {
    return this.contextPreview.previewModelCall(modelCallId);
  }
}
