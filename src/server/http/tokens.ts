import type { ContextBuilder } from '../../context/index.js';
import type { ReactCore } from '../../core/index.js';
import type { PlannerCore } from '../../core/index.js';
import type { AgentSessionStore } from '../../storage/index.js';

export const AGENT_SESSION_STORE = Symbol('AGENT_SESSION_STORE');
export const AGENT_CONTEXT_BUILDER = Symbol('AGENT_CONTEXT_BUILDER');
export const AGENT_REACT_CORE = Symbol('AGENT_REACT_CORE');
export const AGENT_PLANNER_CORE = Symbol('AGENT_PLANNER_CORE');
export const AGENT_PLANNER_STEP_REACT_CORE = Symbol('AGENT_PLANNER_STEP_REACT_CORE');
export const AGENT_CODE_CORE = Symbol('AGENT_CODE_CORE');
export const AGENT_SANDBOX_ROOT = Symbol('AGENT_SANDBOX_ROOT');
export const AGENT_MODEL_NAME = Symbol('AGENT_MODEL_NAME');

export interface AgentServerModuleOptions {
  store: AgentSessionStore;
  contextBuilder: ContextBuilder;
  react: ReactCore;
  planner: PlannerCore;
  plannerStepReact: ReactCore;
  code?: ReactCore;
  sandboxRoot?: string;
  modelName?: string;
}
