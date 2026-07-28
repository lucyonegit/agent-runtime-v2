import { Controller, Get, Param, Post } from '@nestjs/common';
import { ManagedProcessManager } from '../../tools/index.js';

@Controller('managed-processes')
export class AgentManagedProcessController {
  constructor(private readonly managedProcesses: ManagedProcessManager) {}

  @Get(':processId')
  getManagedProcess(@Param('processId') processId: string) {
    return this.managedProcesses.getProcess(processId);
  }

  @Get(':processId/logs')
  async getManagedProcessLogs(@Param('processId') processId: string) {
    return { processId, logs: await this.managedProcesses.readLogs(processId) };
  }

  @Post(':processId/stop')
  stopManagedProcess(@Param('processId') processId: string) {
    return this.managedProcesses.stopProcess(processId);
  }
}
