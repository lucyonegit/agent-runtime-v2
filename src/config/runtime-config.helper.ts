import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  RuntimeConfigFile,
  ToolsConfig,
} from './runtime-config.js';
import { DASHSCOPE_OPENAI_BASE_URL } from '../runtime/model/model-profiles.js';

const BUNDLED_CONFIG_FILE = fileURLToPath(new URL('./runtime.json', import.meta.url));

export function bundledRuntimeConfigPath(): string {
  return BUNDLED_CONFIG_FILE;
}

export function readBundledRuntimeConfigFile(): RuntimeConfigFile {
  return readConfigFile(BUNDLED_CONFIG_FILE) as RuntimeConfigFile;
}

export function loadRuntimeConfigFile(
  configFile: string,
  env: NodeJS.ProcessEnv
): RuntimeConfigFile {
  const defaults = readBundledRuntimeConfigFile();
  const fromFile = configFile === BUNDLED_CONFIG_FILE
    ? {}
    : readConfigFile(configFile);
  const config = deepMerge(defaults, fromFile);
  applyEnvironmentOverrides(config, env);
  validateConfig(config);
  return config;
}

function readConfigFile(path: string): Partial<RuntimeConfigFile> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Runtime config file was not found: ${path}`);
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new TypeError('Runtime config root must be an object.');
    return parsed as Partial<RuntimeConfigFile>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Runtime config is not valid JSON: ${path}`, { cause: error });
    }
    throw error;
  }
}

function applyEnvironmentOverrides(
  config: RuntimeConfigFile,
  env: NodeJS.ProcessEnv
): void {
  assignString(env, 'AGENT_RUNTIME_WORKER_ID', value => { config.runtime.workerId = value; });
  assignString(env, 'AGENT_SANDBOX_ROOT', value => { config.runtime.sandboxRoot = value; });
  assignString(env, 'AGENT_SERVER_HOST', value => { config.server.host = value; });
  assignPositiveInteger(env, 'AGENT_SERVER_PORT', value => { config.server.port = value; });
  assignString(env, 'AGENT_SERVER_AUTH_TOKEN', value => { config.server.authToken = value; });
  assignBoolean(env, 'AGENT_SERVER_ENABLE_DEBUG_ENDPOINTS', value => {
    config.server.debugEndpointsEnabled = value;
  });
  assignString(env, 'DATABASE_URL', value => { config.postgres.url = value; });

  if (env.DASHSCOPE_API_KEY?.trim()) {
    const changedProvider = config.model.provider !== 'dashscope';
    config.model.provider = 'dashscope';
    config.model.apiKey = env.DASHSCOPE_API_KEY.trim();
    if (changedProvider && !env.OPENAI_BASE_URL?.trim()) {
      config.model.baseURL = DASHSCOPE_OPENAI_BASE_URL;
    }
  } else if (env.OPENAI_API_KEY?.trim()) {
    const changedProvider = config.model.provider !== 'openai-compatible';
    config.model.provider = 'openai-compatible';
    config.model.apiKey = env.OPENAI_API_KEY.trim();
    if (changedProvider && !env.OPENAI_BASE_URL?.trim()) config.model.baseURL = '';
  }
  assignString(env, 'OPENAI_BASE_URL', value => { config.model.baseURL = value; });
  assignString(env, 'OPENAI_MODEL', value => { config.model.modelName = value; });
  assignPositiveInteger(env, 'MODEL_CONTEXT_WINDOW_TOKENS', value => {
    config.model.tokens.contextWindowTokens = value;
  });
  assignPositiveInteger(env, 'MODEL_INPUT_TOKEN_LIMIT', value => {
    config.model.tokens.inputTokenLimit = value;
  });
  assignPositiveInteger(env, 'MODEL_OUTPUT_TOKEN_LIMIT', value => {
    config.model.tokens.outputTokenLimit = value;
  });

  assignPositiveInteger(env, 'TASK_OWNERSHIP_TIMEOUT_MS', value => {
    config.execution.ownershipTimeoutMs = value;
  });
  assignPositiveInteger(env, 'TASK_OWNERSHIP_REFRESH_MS', value => {
    config.execution.ownershipRefreshMs = value;
  });
  assignPositiveInteger(env, 'TASK_RECOVERY_SCAN_MS', value => {
    config.execution.recoveryScanIntervalMs = value;
  });
  assignBoolean(env, 'AGENT_RUNTIME_ALLOW_PROXY_FAKE_IPS', value => {
    config.tools.browser.allowProxyFakeIps = value;
  });
}

function validateConfig(config: RuntimeConfigFile): void {
  nonEmptyString(config.runtime.workerId, 'runtime.workerId');
  nonEmptyString(config.runtime.sandboxRoot, 'runtime.sandboxRoot');
  nonEmptyString(config.server.host, 'server.host');
  positiveInteger(config.server.port, 'server.port');
  if (config.server.port > 65_535) throw new RangeError('server.port must be at most 65535.');
  if (typeof config.server.authToken !== 'string') {
    throw new TypeError('server.authToken must be a string.');
  }
  if (config.server.authToken.length > 0 && config.server.authToken.length < 32) {
    throw new RangeError('server.authToken must contain at least 32 characters when configured.');
  }
  booleanValue(config.server.debugEndpointsEnabled, 'server.debugEndpointsEnabled');
  if (config.server.logger.length === 0) throw new RangeError('server.logger cannot be empty.');
  if (!Array.isArray(config.server.cors.origin) || config.server.cors.origin.length === 0) {
    throw new TypeError('server.cors.origin must be a non-empty array of explicit origins.');
  }
  for (const origin of config.server.cors.origin) validateHttpOrigin(origin);
  booleanValue(config.server.cors.credentials, 'server.cors.credentials');
  nonEmptyString(config.postgres.url, 'postgres.url');
  positiveInteger(config.postgres.maxConnections, 'postgres.maxConnections');
  positiveInteger(config.postgres.idleTimeoutMs, 'postgres.idleTimeoutMs');
  positiveInteger(config.postgres.connectionTimeoutMs, 'postgres.connectionTimeoutMs');
  booleanValue(config.postgres.ssl, 'postgres.ssl');

  if (!['dashscope', 'openai-compatible'].includes(config.model.provider)) {
    throw new TypeError('model.provider must be dashscope or openai-compatible.');
  }
  nonEmptyString(config.model.modelName, 'model.modelName');
  finiteNumber(config.model.temperature, 'model.temperature');
  booleanValue(config.model.streaming, 'model.streaming');
  positiveInteger(config.model.requestTimeoutMs, 'model.requestTimeoutMs');
  nonNegativeInteger(config.model.maxRetries, 'model.maxRetries');
  for (const [name, value] of Object.entries(config.model.tokens)) {
    if (value !== null) positiveInteger(value, `model.tokens.${name}`);
  }

  for (const [name, value] of Object.entries(config.execution)) {
    positiveInteger(value, `execution.${name}`);
  }
  if (config.execution.ownershipRefreshMs >= config.execution.ownershipTimeoutMs) {
    throw new RangeError(
      'execution.ownershipRefreshMs must be shorter than execution.ownershipTimeoutMs.'
    );
  }

  for (const [name, value] of Object.entries(config.context)) {
    positiveInteger(value, `context.${name}`);
  }

  validateTools(config.tools);
}

function validateHttpOrigin(value: unknown): void {
  nonEmptyString(value, 'server.cors.origin[]');
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError(`Invalid CORS origin: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
    throw new TypeError(`CORS origin must be an explicit HTTP(S) origin: ${value}`);
  }
}

function validateTools(config: ToolsConfig): void {
  for (const [name, value] of Object.entries(config.enabled)) {
    booleanValue(value, `tools.enabled.${name}`);
  }
  for (const [name, value] of Object.entries(config.filesystem)) {
    positiveInteger(value, `tools.filesystem.${name}`);
  }
  nonEmptyString(config.shell.executable, 'tools.shell.executable');
  for (const [name, value] of Object.entries(config.shell).filter(([, value]) => (
    typeof value === 'number'
  ))) {
    positiveInteger(value as number, `tools.shell.${name}`);
  }
  if (config.shell.defaultTimeoutMs > config.shell.maximumTimeoutMs) {
    throw new RangeError('tools.shell timeout bounds are inconsistent.');
  }
  for (const [name, value] of Object.entries(config.managedProcesses).filter(([, value]) => (
    typeof value === 'number'
  ))) {
    positiveInteger(value as number, `tools.managedProcesses.${name}`);
  }
  if (config.managedProcesses.portRangeStart > config.managedProcesses.portRangeEnd) {
    throw new RangeError('tools.managedProcesses port range is inconsistent.');
  }
  for (const [name, value] of Object.entries(config.browser).filter(([, value]) => (
    typeof value === 'number'
  ))) {
    positiveInteger(value as number, `tools.browser.${name}`);
  }
  booleanValue(config.browser.allowProxyFakeIps, 'tools.browser.allowProxyFakeIps');
}

function assignString(
  env: NodeJS.ProcessEnv,
  name: string,
  assign: (value: string) => void
): void {
  const value = env[name]?.trim();
  if (value) assign(value);
}

function assignPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  assign: (value: number) => void
): void {
  const raw = env[name]?.trim();
  if (!raw) return;
  const value = Number(raw);
  positiveInteger(value, name);
  assign(value);
}

function assignBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  assign: (value: boolean) => void
): void {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return;
  if (!['true', 'false'].includes(raw)) {
    throw new TypeError(`${name} must be true or false.`);
  }
  assign(raw === 'true');
}

function nonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
}

function positiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function nonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function finiteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
}

function booleanValue(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean.`);
}

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const output = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = output[key];
    output[key] = isRecord(current) && isRecord(value)
      ? deepMerge(current, value)
      : structuredClone(value);
  }
  return output as T;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
