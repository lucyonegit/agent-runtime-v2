import type { RuntimeTool } from '../runtime/execution/tool-executor.js';
import { createArtifactTools } from './artifact-tools.js';
import { createBasicTools } from './basic-tools.js';
import { createBrowserTools } from './browser-tools.js';
import { createFilesystemTools } from './filesystem-tools.js';
import { createHitlTools } from './hitl-tools.js';
import { createShellTools } from './shell-tool.js';
import { createManagedProcessTools } from './process-tools.js';
import type { ManagedProcessManager } from './managed-process-manager.js';

export {
  ManagedProcessManager,
} from './managed-process-manager.js';

export {
  removeSessionSandbox,
} from './helpers/workspace-path.helper.js';

export function createRuntimeTools(options: { managedProcessManager?: ManagedProcessManager } = {}): RuntimeTool[] {
  return [
    ...createHitlTools(),
    ...createBasicTools(),
    ...createArtifactTools(),
    ...createFilesystemTools(),
    ...createShellTools(),
    ...(options.managedProcessManager ? createManagedProcessTools(options.managedProcessManager) : []),
    ...createBrowserTools(),
  ];
}
