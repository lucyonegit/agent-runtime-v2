import { selectInheritedHostEnvironment } from '../../../config/process-environment-policy.js';

export function buildWorkspaceProcessEnv(
  overrides: Record<string, string> = {},
  hostEnvironment: NodeJS.ProcessEnv,
  inheritedKeys: readonly string[]
): NodeJS.ProcessEnv {
  return {
    ...selectInheritedHostEnvironment(hostEnvironment, inheritedKeys),
    ...overrides,
  };
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
