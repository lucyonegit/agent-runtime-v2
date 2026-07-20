import type { RuntimeTool } from '../../runtime/tool-executor.js';
import { createRuntimeTools } from '../../tools/index.js';
import { createPlanTools, type CreatePlanToolsOptions } from '../../tools/plan-tools.js';

export function createDefaultTools(options: CreatePlanToolsOptions): RuntimeTool[] {
  return [...createPlanTools(options), ...createRuntimeTools()];
}
