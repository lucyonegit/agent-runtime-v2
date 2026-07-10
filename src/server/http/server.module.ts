import { DynamicModule, Module } from '@nestjs/common';
import { AgentRuntimeService } from './agent-runtime.service.js';
import { AgentsController } from './controllers/agents.controller.js';
import { CodeProjectsController } from './controllers/code-projects.controller.js';
import { SessionsController } from './controllers/sessions.controller.js';
import { SseEventBus } from './sse-event-bus.js';
import {
  AGENT_CONTEXT_BUILDER,
  AGENT_CODE_CORE,
  AGENT_MODEL_NAME,
  AGENT_PLANNER_CORE,
  AGENT_PLANNER_STEP_REACT_CORE,
  AGENT_REACT_CORE,
  AGENT_SANDBOX_ROOT,
  AGENT_SESSION_STORE,
  type AgentServerModuleOptions,
} from './tokens.js';

@Module({})
export class AgentServerModule {
  static register(options: AgentServerModuleOptions): DynamicModule {
    return {
      module: AgentServerModule,
      controllers: [AgentsController, SessionsController, CodeProjectsController],
      providers: [
        SseEventBus,
        AgentRuntimeService,
        { provide: AGENT_SESSION_STORE, useValue: options.store },
        { provide: AGENT_CONTEXT_BUILDER, useValue: options.contextBuilder },
        { provide: AGENT_REACT_CORE, useValue: options.react },
        { provide: AGENT_PLANNER_CORE, useValue: options.planner },
        { provide: AGENT_PLANNER_STEP_REACT_CORE, useValue: options.plannerStepReact },
        { provide: AGENT_CODE_CORE, useValue: options.code ?? options.react },
        { provide: AGENT_SANDBOX_ROOT, useValue: options.sandboxRoot ?? '.agent-sandbox' },
        { provide: AGENT_MODEL_NAME, useValue: options.modelName },
      ],
      exports: [AgentRuntimeService, SseEventBus],
    };
  }
}
