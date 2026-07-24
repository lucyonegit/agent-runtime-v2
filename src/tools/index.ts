import type { RuntimeTool } from '../runtime/execution/tool-executor.js';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from '../config/tools-config.js';
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

export function createRuntimeTools(options: {
  managedProcessManager?: ManagedProcessManager;
  config?: ToolsConfig;
} = {}): RuntimeTool[] {
  const config = options.config ?? DEFAULT_TOOLS_CONFIG;
  return [
    ...(config.enabled.hitl ? createHitlTools() : []),
    ...(config.enabled.basic ? createBasicTools() : []),
    ...(config.enabled.artifacts ? createArtifactTools(config.filesystem) : []),
    ...(config.enabled.filesystem ? createFilesystemTools(config.filesystem) : []),
    ...(config.enabled.shell ? createShellTools(config) : []),
    ...(config.enabled.managedProcesses && options.managedProcessManager
      ? createManagedProcessTools(options.managedProcessManager, config.managedProcesses)
      : []),
    ...(config.enabled.browser ? createBrowserTools(config.browser) : []),
  ];
}
