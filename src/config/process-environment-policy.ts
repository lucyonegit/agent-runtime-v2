const SENSITIVE_ENVIRONMENT_KEYS = new Set([
  'DATABASE_URL',
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'KUBECONFIG',
  'DOCKER_CONFIG',
  'NETRC',
  'NPM_CONFIG_USERCONFIG',
  'HOST',
  'PORT',
]);

const SENSITIVE_ENVIRONMENT_SEGMENT =
  /(^|_)(AUTH|BEARER|COOKIE|CREDENTIAL|CREDENTIALS|PASSWD|PASSWORD|SECRET|SESSION|TOKEN)(_|$)/;

export function isSensitiveHostEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return SENSITIVE_ENVIRONMENT_KEYS.has(normalized)
    || normalized.startsWith('AGENT_RUNTIME_')
    || normalized.startsWith('AGENT_SERVER_')
    || normalized.includes('ACCESS_KEY')
    || normalized.includes('API_KEY')
    || normalized.includes('PRIVATE_KEY')
    || SENSITIVE_ENVIRONMENT_SEGMENT.test(normalized);
}

export function selectInheritedHostEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
  inheritedKeys: readonly string[]
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of inheritedKeys) {
    if (isSensitiveHostEnvironmentKey(key)) continue;
    const value = hostEnvironment[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}
