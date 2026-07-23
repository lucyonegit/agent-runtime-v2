import type { RuntimeTool } from '../../runtime/execution/tool-executor.js';
import { createRuntimeTools } from '../../tools/index.js';
import type { ManagedProcessManager } from '../../tools/index.js';
import { createPlanTools, type CreatePlanToolsOptions } from '../../tools/plan-tools.js';

export function createDefaultTools(
  options: CreatePlanToolsOptions & { managedProcessManager?: ManagedProcessManager }
): RuntimeTool[] {
  return [
    ...createPlanTools(options),
    ...createRuntimeTools({ managedProcessManager: options.managedProcessManager }),
  ];
}
