import { Module, type DynamicModule } from '@nestjs/common';
import { AgentRuntime } from '../../orchestration/agent-runtime.js';
import { ContextPreviewService } from '../debug/context-preview.service.js';
import { RuntimeEventBus } from '../runtime/runtime-event-bus.js';
import { AgentController } from './agent.controller.js';
import { ManagedProcessManager } from '../../tools/index.js';

@Module({})
export class AgentHttpModule {
  static forRoot(
    runtime: AgentRuntime,
    events: RuntimeEventBus,
    contextPreview: ContextPreviewService,
    managedProcesses: ManagedProcessManager
  ): DynamicModule {
    return {
      module: AgentHttpModule,
      controllers: [AgentController],
      providers: [
        { provide: AgentRuntime, useValue: runtime },
        { provide: RuntimeEventBus, useValue: events },
        { provide: ContextPreviewService, useValue: contextPreview },
        { provide: ManagedProcessManager, useValue: managedProcesses },
      ],
    };
  }
}
