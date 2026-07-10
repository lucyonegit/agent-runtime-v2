import { Module, type DynamicModule } from '@nestjs/common';
import { AgentRuntime } from '../../orchestration/agent-runtime.js';
import { RuntimeEventBus } from '../runtime/runtime-event-bus.js';
import { AgentController } from './agent.controller.js';

@Module({})
export class AgentHttpModule {
  static forRoot(runtime: AgentRuntime, events: RuntimeEventBus): DynamicModule {
    return {
      module: AgentHttpModule,
      controllers: [AgentController],
      providers: [
        { provide: AgentRuntime, useValue: runtime },
        { provide: RuntimeEventBus, useValue: events },
      ],
    };
  }
}
