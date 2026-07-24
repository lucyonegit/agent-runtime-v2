import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONTEXT_CONFIG,
  type ContextConfig,
} from './context-config.js';
import {
  DEFAULT_EXECUTION_CONFIG,
  type ExecutionConfig,
} from './execution-config.js';
import {
  DEFAULT_MODEL_CONFIG,
  resolveModelTokenLimits,
  type ModelConfig,
  type ResolvedModelTokenLimits,
} from './model-config.js';
import {
  DEFAULT_POSTGRES_CONFIG,
  type PostgresConfig,
} from './postgres-config.js';
import {
  DEFAULT_SERVER_CONFIG,
  type ServerConfig,
} from './server-config.js';
import {
  DEFAULT_TOOLS_CONFIG,
  type ToolsConfig,
} from './tools-config.js';

export interface RuntimeConfig {
  workerId: string;
  sandboxRoot: string;
  server: ServerConfig;
  postgres: PostgresConfig;
  model: ModelConfig;
  modelTokenLimits: ResolvedModelTokenLimits;
  execution: ExecutionConfig;
  context: ContextConfig;
  tools: ToolsConfig;
}

interface RuntimeConfigFile {
  runtime: {
    workerId: string;
    sandboxRoot: string;
  };
  server: ServerConfig;
  postgres: PostgresConfig;
  model: ModelConfig;
  execution: ExecutionConfig;
  context: ContextConfig;
  tools: ToolsConfig;
}

const DEFAULT_CONFIG_FILE: RuntimeConfigFile = {
  runtime: {
    workerId: 'auto',
    sandboxRoot: '.agent-sandbox',
  },
  server: structuredClone(DEFAULT_SERVER_CONFIG),
  postgres: structuredClone(DEFAULT_POSTGRES_CONFIG),
  model: structuredClone(DEFAULT_MODEL_CONFIG),
  execution: structuredClone(DEFAULT_EXECUTION_CONFIG),
  context: structuredClone(DEFAULT_CONTEXT_CONFIG),
  tools: structuredClone(DEFAULT_TOOLS_CONFIG),
};

export interface LoadRuntimeConfigOptions {
  env?: NodeJS.ProcessEnv;
  configFile?: string;
}

/**
 * The only boundary allowed to read environment variables.
 *
 * Precedence is: built-in safe defaults < src/config/runtime.json < environment.
 * JSON contains deployable non-secret policy; environment supplies secrets and
 * narrowly scoped deployment overrides.
 */
export function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions = {}
): Readonly<RuntimeConfig> {
  const env = options.env ?? process.env;
  const configFile = options.configFile
    ?? env.AGENT_RUNTIME_CONFIG_FILE
    ?? fileURLToPath(new URL('./runtime.json', import.meta.url));
  const fromFile = readConfigFile(configFile);
  const config = deepMerge(DEFAULT_CONFIG_FILE, fromFile);
  applyEnvironmentOverrides(config, env);
  validateConfig(config);

  const workerId = config.runtime.workerId === 'auto'
    ? `worker_${process.pid}`
    : config.runtime.workerId;
  const resolved: RuntimeConfig = {
    workerId,
    sandboxRoot: config.runtime.sandboxRoot,
    server: config.server,
    postgres: config.postgres,
    model: config.model,
    modelTokenLimits: resolveModelTokenLimits(config.model),
    execution: config.execution,
    context: config.context,
    tools: {
      ...config.tools,
      environment: {
        ...config.tools.environment,
        hostEnvironment: { ...env },
      },
    },
  };
  return deepFreeze(resolved);
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
  assignString(env, 'DATABASE_URL', value => { config.postgres.url = value; });

  if (env.DASHSCOPE_API_KEY?.trim()) {
    const changedProvider = config.model.provider !== 'dashscope';
    config.model.provider = 'dashscope';
    config.model.apiKey = env.DASHSCOPE_API_KEY.trim();
    if (changedProvider && !env.OPENAI_BASE_URL?.trim()) {
      config.model.baseURL = DEFAULT_MODEL_CONFIG.baseURL;
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

  assignPositiveInteger(env, 'JOB_LEASE_MS', value => {
    config.execution.ownershipTimeoutMs = value;
  });
  assignPositiveInteger(env, 'JOB_HEARTBEAT_MS', value => {
    config.execution.ownershipRefreshMs = value;
  });
  assignPositiveInteger(env, 'JOB_RECOVERY_SCAN_MS', value => {
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
  if (config.server.logger.length === 0) throw new RangeError('server.logger cannot be empty.');
  if (config.server.cors.origin !== true && !Array.isArray(config.server.cors.origin)) {
    throw new TypeError('server.cors.origin must be true or an array of origins.');
  }
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

  positiveInteger(config.context.compression.maximumPasses, 'context.compression.maximumPasses');
  booleanValue(config.context.compression.enabled, 'context.compression.enabled');
  positiveInteger(
    config.context.compression.recentRawTokenBudget,
    'context.compression.recentRawTokenBudget'
  );
  positiveInteger(
    config.context.compression.minimumRecentGroups,
    'context.compression.minimumRecentGroups'
  );
  positiveInteger(
    config.context.compression.batchMinimumTokens,
    'context.compression.batchMinimumTokens'
  );
  positiveInteger(
    config.context.compression.batchMaximumTokens,
    'context.compression.batchMaximumTokens'
  );
  ratio(config.context.compression.batchInputFraction, 'context.compression.batchInputFraction');
  const pressure = config.context.pressure;
  ratio(pressure.watchRatio, 'context.pressure.watchRatio');
  ratio(pressure.compressRatio, 'context.pressure.compressRatio');
  ratio(pressure.mustCompressRatio, 'context.pressure.mustCompressRatio');
  ratio(pressure.criticalRatio, 'context.pressure.criticalRatio');
  if (!(
    pressure.watchRatio < pressure.compressRatio
    && pressure.compressRatio < pressure.mustCompressRatio
    && pressure.mustCompressRatio < pressure.criticalRatio
  )) {
    throw new RangeError('Context pressure ratios must be strictly increasing.');
  }
  positiveInteger(
    config.context.estimation.historySampleSize,
    'context.estimation.historySampleSize'
  );
  positiveInteger(
    config.context.estimation.minimumCalibrationSamples,
    'context.estimation.minimumCalibrationSamples'
  );
  if (
    config.context.estimation.minimumCalibrationSamples
    > config.context.estimation.historySampleSize
  ) {
    throw new RangeError(
      'context.estimation.minimumCalibrationSamples cannot exceed historySampleSize.'
    );
  }
  for (const name of [
    'fallbackCalibrationFactor',
    'minimumCalibrationFactor',
    'maximumCalibrationFactor',
  ] as const) {
    positiveNumber(config.context.estimation[name], `context.estimation.${name}`);
  }
  ratio(
    config.context.estimation.calibrationPercentile,
    'context.estimation.calibrationPercentile'
  );
  positiveInteger(
    config.context.estimation.fallbackErrorReserveTokens,
    'context.estimation.fallbackErrorReserveTokens'
  );
  positiveInteger(
    config.context.estimation.minimumErrorReserveTokens,
    'context.estimation.minimumErrorReserveTokens'
  );
  for (const [name, value] of Object.entries(config.context.projection)) {
    if (name === 'toolResultHeadRatio') ratio(value, `context.projection.${name}`);
    else positiveInteger(value, `context.projection.${name}`);
  }

  validateTools(config.tools);
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
  if (config.shell.minimumTimeoutMs > config.shell.defaultTimeoutMs
    || config.shell.defaultTimeoutMs > config.shell.maximumTimeoutMs) {
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
  if (config.managedProcesses.allowedHosts.length === 0) {
    throw new RangeError('tools.managedProcesses.allowedHosts cannot be empty.');
  }
  config.managedProcesses.allowedHosts.forEach((host, index) => {
    nonEmptyString(host, `tools.managedProcesses.allowedHosts[${index}]`);
  });
  for (const [name, value] of Object.entries(config.browser).filter(([, value]) => (
    typeof value === 'number'
  ))) {
    positiveInteger(value as number, `tools.browser.${name}`);
  }
  booleanValue(config.browser.allowProxyFakeIps, 'tools.browser.allowProxyFakeIps');
  for (const [name, values] of Object.entries({
    blockedKeys: config.environment.blockedKeys,
    blockedPrefixes: config.environment.blockedPrefixes,
  })) {
    if (!Array.isArray(values)) throw new TypeError(`tools.environment.${name} must be an array.`);
    values.forEach((value, index) => {
      nonEmptyString(value, `tools.environment.${name}[${index}]`);
    });
  }
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

function positiveNumber(value: unknown, name: string): asserts value is number {
  finiteNumber(value, name);
  if (value <= 0) throw new RangeError(`${name} must be greater than zero.`);
}

function booleanValue(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean.`);
}

function ratio(value: unknown, name: string): asserts value is number {
  finiteNumber(value, name);
  if (value <= 0 || value >= 1) throw new RangeError(`${name} must be between 0 and 1.`);
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

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
