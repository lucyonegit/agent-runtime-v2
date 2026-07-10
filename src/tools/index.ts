import { createArtifactTools } from './artifact-tools.js';
import { createBasicTools } from './basic-tools.js';
import { createBrowserTools } from './browser-tools.js';
import { createCodeFilesystemTools } from './code-filesystem-tools.js';
import { createFilesystemTools } from './filesystem-tools.js';
import { createHitlTools } from './hitl-tools.js';
import { createPlannerStepTools } from './planner-step-tools.js';
import type { RuntimeTool } from './types.js';

export type { RuntimeTool } from './types.js';
export { createPlannerStepTools, SUBMIT_STEP_RESULT_TOOL } from './planner-step-tools.js';
export {
  createSandbox,
  ensureSandboxArea,
  getAreaRoot,
  getSandboxSessionRoot,
  removeSessionSandbox,
  resolveSandboxPath,
  type SandboxArea,
  type ToolSandbox,
} from './sandbox.js';

export function createRuntimeTools(): RuntimeTool[] {
  return [
    ...createHitlTools(),
    ...createBasicTools(),
    ...createArtifactTools(),
    ...createFilesystemTools(),
    ...createBrowserTools(),
  ];
}

export function createPlannerStepRuntimeTools(): RuntimeTool[] {
  return [
    ...createRuntimeTools(),
    ...createPlannerStepTools(),
  ];
}

export function createCodeRuntimeTools(): RuntimeTool[] {
  return [
    ...createHitlTools(),
    ...createBasicTools(),
    ...createCodeFilesystemTools(),
    ...createBrowserTools(),
  ];
}

export function createOpenAIToolDefinitions(tools: RuntimeTool[]) {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
