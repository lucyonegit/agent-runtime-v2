import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AgentRuntime } from '../../orchestration/agent-runtime.js';
import { ContextPreviewService } from '../debug/context-preview.service.js';
import { RuntimeEventBus } from '../runtime/runtime-event-bus.js';
import { AgentDebugController } from './agent-debug.controller.js';
import { AgentController } from './agent.controller.js';
import { ManagedProcessManager } from '../../tools/index.js';
import {
  RUNTIME_HTTP_AUTH_TOKEN,
  RuntimeHttpAuthGuard,
} from './runtime-http-auth.guard.js';

@Module({})
export class AgentHttpModule {
  static forRoot(
    runtime: AgentRuntime,
    events: RuntimeEventBus,
    contextPreview: ContextPreviewService,
    managedProcesses: ManagedProcessManager,
    authToken: string,
    debugEndpointsEnabled: boolean
  ): DynamicModule {
    return {
      module: AgentHttpModule,
      controllers: debugEndpointsEnabled
        ? [AgentController, AgentDebugController]
        : [AgentController],
      providers: [
        { provide: AgentRuntime, useValue: runtime },
        { provide: RuntimeEventBus, useValue: events },
        { provide: ManagedProcessManager, useValue: managedProcesses },
        { provide: RUNTIME_HTTP_AUTH_TOKEN, useValue: authToken },
        { provide: APP_GUARD, useClass: RuntimeHttpAuthGuard },
        ...(debugEndpointsEnabled
          ? [{ provide: ContextPreviewService, useValue: contextPreview }]
          : []),
      ],
    };
  }
}
