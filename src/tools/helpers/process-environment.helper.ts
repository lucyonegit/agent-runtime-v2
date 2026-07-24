import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from '../../config/tools-config.js';

export function buildWorkspaceProcessEnv(
  overrides: Record<string, string> = {},
  config: ToolsConfig['environment'] = DEFAULT_TOOLS_CONFIG.environment
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...(config.hostEnvironment ?? {}) };

  // HOST and PORT configure many application frameworks. They belong to the
  // child application, not to the Agent Runtime HTTP server.
  delete environment.HOST;
  delete environment.PORT;

  for (const key of config.blockedKeys) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (config.blockedPrefixes.some(prefix => key.startsWith(prefix))) {
      delete environment[key];
    }
  }

  return { ...environment, ...overrides };
}

export function stringRecord(value: unknown, fieldName: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object containing string values.`);
  }
  const entries = Object.entries(value);
  if (entries.some(([, child]) => typeof child !== 'string')) {
    throw new TypeError(`${fieldName} must contain only string values.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
