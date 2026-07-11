import type { RuntimeTool } from '../runtime/tool-executor.js';
import { createArtifactTools } from './artifact-tools.js';
import { createBasicTools } from './basic-tools.js';
import { createBrowserTools } from './browser-tools.js';
import { createFilesystemTools } from './filesystem-tools.js';
import { createHitlTools } from './hitl-tools.js';

export {
  codeProjectRoot,
  removeCodeProjectSandbox,
  removeSessionSandbox,
  resolveSessionAreaPath,
  resolveWorkspacePath,
  sessionAreaRoot,
  workspaceRoot,
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
