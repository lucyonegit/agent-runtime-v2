const BLOCKED_ENVIRONMENT_KEYS = [
  'DATABASE_URL',
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
];
const BLOCKED_ENVIRONMENT_PREFIXES = [
  'AGENT_RUNTIME_',
  'AGENT_SERVER_',
];

export function buildWorkspaceProcessEnv(
  overrides: Record<string, string> = {},
  hostEnvironment: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...hostEnvironment };

  // HOST and PORT configure many application frameworks. They belong to the
  // child application, not to the Agent Runtime HTTP server.
  delete environment.HOST;
  delete environment.PORT;

  for (const key of BLOCKED_ENVIRONMENT_KEYS) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (BLOCKED_ENVIRONMENT_PREFIXES.some(prefix => key.startsWith(prefix))) {
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
