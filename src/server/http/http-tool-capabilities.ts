import type { RuntimeConfig, ToolsConfig } from '../../config/runtime-config.js';

/**
 * The standalone HTTP transport has a smaller trust boundary than Electron IPC.
 * Intersect its explicit capability grant with globally enabled Runtime tools
 * without mutating the shared configuration object.
 */
export function restrictHttpToolCapabilities(config: RuntimeConfig): RuntimeConfig {
  const capabilities = new Set(config.server.toolCapabilities);
  const globallyEnabled = config.tools.enabled;
  const enabled: ToolsConfig['enabled'] = {
    hitl: globallyEnabled.hitl,
    basic: globallyEnabled.basic,
    artifacts: globallyEnabled.artifacts && capabilities.has('artifacts'),
    filesystem: globallyEnabled.filesystem && capabilities.has('filesystem'),
    shell: globallyEnabled.shell && capabilities.has('shell'),
    managedProcesses:
      globallyEnabled.managedProcesses && capabilities.has('managedProcesses'),
    browser: globallyEnabled.browser && capabilities.has('browser'),
  };
  return {
    ...config,
    tools: {
      ...config.tools,
      enabled,
    },
  };
}
