import type { RuntimeTool } from '../runtime/execution/tool-executor.js';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from '../config/runtime-config.js';
import { createArtifactTools } from './artifacts/artifact-tools.js';
import { createBasicTools } from './basic/basic-tools.js';
import { createBrowserTools } from './browser/browser-tools.js';
import { createFilesystemTools } from './filesystem/filesystem-tools.js';
import { createHitlTools } from './hitl/hitl-tools.js';
import { createShellTools } from './process/shell-tool.js';
import { createManagedProcessTools } from './process/process-tools.js';
import type { ManagedProcessManager } from './process/managed-process-manager.js';

export {
  ManagedProcessManager,
} from './process/managed-process-manager.js';

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
