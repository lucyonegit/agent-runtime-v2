const PRIVATE_RUNTIME_KEYS = new Set([
  'DATABASE_URL',
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
]);

export function buildWorkspaceProcessEnv(
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };

  // HOST and PORT configure many application frameworks. They belong to the
  // child application, not to the Agent Runtime HTTP server.
  delete environment.HOST;
  delete environment.PORT;

  for (const key of PRIVATE_RUNTIME_KEYS) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (key.startsWith('AGENT_RUNTIME_') || key.startsWith('AGENT_SERVER_')) {
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

