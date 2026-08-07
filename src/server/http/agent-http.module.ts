import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AgentRuntime } from '../../orchestration/agent-runtime.js';
import { ContextPreviewService } from '../debug/context-preview.service.js';
import { RuntimeEventBus } from '../runtime/runtime-event-bus.js';
import { AgentDebugController } from './agent-debug.controller.js';
import {
  AgentArtifactController,
  RUNTIME_ARTIFACT_SANDBOX_ROOT,
} from './agent-artifact.controller.js';
import { AgentContextController } from './agent-context.controller.js';
import { AgentManagedProcessController } from './agent-managed-process.controller.js';
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
    sandboxRoot: string,
    authToken: string,
    debugEndpointsEnabled: boolean,
    managedProcessEndpointsEnabled: boolean
  ): DynamicModule {
    return {
      module: AgentHttpModule,
      controllers: [
        AgentController,
        AgentArtifactController,
        AgentContextController,
        ...(debugEndpointsEnabled ? [AgentDebugController] : []),
        ...(managedProcessEndpointsEnabled ? [AgentManagedProcessController] : []),
      ],
      providers: [
        { provide: AgentRuntime, useValue: runtime },
        { provide: RuntimeEventBus, useValue: events },
        { provide: RUNTIME_ARTIFACT_SANDBOX_ROOT, useValue: sandboxRoot },
        { provide: ContextPreviewService, useValue: contextPreview },
        { provide: RUNTIME_HTTP_AUTH_TOKEN, useValue: authToken },
        { provide: APP_GUARD, useClass: RuntimeHttpAuthGuard },
        ...(managedProcessEndpointsEnabled
          ? [{ provide: ManagedProcessManager, useValue: managedProcesses }]
          : []),
      ],
    };
  }
}
