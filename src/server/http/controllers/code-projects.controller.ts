import { Controller, Delete, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { AgentRuntimeService } from '../agent-runtime.service.js';

@Controller('sessions/:sessionId/projects')
export class CodeProjectsController {
  constructor(private readonly runtime: AgentRuntimeService) {}

  @Delete(':projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCodeProject(
    @Param('sessionId') sessionId: string,
    @Param('projectId') projectId: string
  ) {
    return this.runtime.deleteCodeProject(sessionId, projectId);
  }
}
