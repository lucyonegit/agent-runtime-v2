import type { RuntimeTool } from '../runtime/tool-executor.js';
import { createArtifactTools } from './artifact-tools.js';
import { createBasicTools } from './basic-tools.js';
import { createBrowserTools } from './browser-tools.js';
import { createFilesystemTools } from './filesystem-tools.js';
import { createHitlTools } from './hitl-tools.js';
import { createShellTools } from './shell-tool.js';

export {
  removeSessionSandbox,
} from './sandbox.js';

export function createRuntimeTools(): RuntimeTool[] {
  return [
    ...createHitlTools(),
    ...createBasicTools(),
    ...createArtifactTools(),
    ...createFilesystemTools(),
    ...createShellTools(),
    ...createBrowserTools(),
  ];
}
